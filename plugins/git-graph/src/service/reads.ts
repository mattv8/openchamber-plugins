import { createHash } from 'node:crypto';
import { access, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { ReadData, ReadRequest, Repository, ServiceContext } from './contracts.js';
import { ServiceError, requireGit, validatePath, validateRef } from './contracts.js';

const HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const MAX_REF_METADATA_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_REF_PAGE_BYTES = 200_000;
const DEFAULT_REF_PAGE_SIZE = 200;
const CursorSchema = z.object({ snapshot: z.string(), offset: z.number().int().nonnegative() });
const id = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);
const text = (value: Buffer) => value.toString('utf8');

function fail(code: 'invalid-request' | 'not-found' | 'unsupported', message: string): never {
  throw new ServiceError(code, message);
}

async function required(context: ServiceContext, repository: Repository, args: readonly string[]) {
  return requireGit(context.runGit, repository.root, args);
}

function assertSnapshot(repository: Repository, request: ReadRequest) {
  if (request.snapshot !== repository.snapshot) throw new ServiceError('snapshot-conflict', 'Read snapshot is stale', true);
}

function refInfo(idValue: string, name: string, revision: string | null, kind?: 'head' | 'local' | 'remote' | 'tag') {
  const resolvedKind = kind ?? (idValue.startsWith('refs/heads/') ? 'local' : idValue.startsWith('refs/remotes/') ? 'remote' : 'tag');
  return { id: idValue, name, revision, kind: resolvedKind, category: resolvedKind === 'remote' ? 'remote-branches' as const : resolvedKind === 'tag' ? 'tags' as const : 'branches' as const };
}

async function inProgress(repository: Repository) {
  const markers: Array<[string, 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect']> = [['MERGE_HEAD', 'merge'], ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert'], ['BISECT_LOG', 'bisect']];
  for (const [marker, state] of markers) {
    if (await access(join(repository.gitDir, marker)).then(() => true).catch(() => false)) return state;
  }
  return null;
}

async function status(context: ServiceContext, repository: Repository) {
  const records = (await required(context, repository, ['status', '--porcelain=v2', '-z', '--branch'])).toString('utf8').split('\0');
  const files: Array<{ path: string; index: string; workingDirectory: string; staged: boolean; unstaged: boolean }> = [];
  let current = '';
  let tracking: string | null = null;
  let ahead = 0;
  let behind = 0;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? '';
    if (record.startsWith('# branch.head ')) current = record.slice(14) === '(detached)' ? '' : record.slice(14);
    else if (record.startsWith('# branch.upstream ')) tracking = record.slice(18) || null;
    else if (record.startsWith('# branch.ab ')) { ahead = Number(/\+(\d+)/.exec(record)?.[1] ?? 0); behind = Number(/-(\d+)/.exec(record)?.[1] ?? 0); }
    else if (record.startsWith('? ')) files.push({ path: record.slice(2), index: '?', workingDirectory: '?', staged: false, unstaged: true });
    else if (record.startsWith('! ')) continue;
    else if (/^[12u] /.test(record)) {
      const fields = record.split(' ');
      const xy = fields[1] ?? '..';
      const pathStart = record.startsWith('1 ') ? 8 : record.startsWith('2 ') ? 9 : 10;
      const path = fields.slice(pathStart).join(' ');
      if (record.startsWith('2 ')) index += 1; // the NUL record after a rename is the old path
      files.push({ path, index: xy[0] ?? '.', workingDirectory: xy[1] ?? '.', staged: xy[0] !== '.', unstaged: xy[1] !== '.' });
    }
  }
  return { current, tracking, ahead, behind, isClean: files.length === 0, files: files.slice(0, 5000), attention: await inProgress(repository) };
}

async function fullInternalRefs(context: ServiceContext, repository: Repository) {
  const raw = await requireGit(context.runGit, repository.root, ['for-each-ref', '--format=%(refname)%00%(refname:short)%00%(objectname)%00%(*objectname)%00%(HEAD)%00%(upstream:short)', 'refs/heads', 'refs/remotes', 'refs/tags'], { maxOutputBytes: MAX_REF_METADATA_OUTPUT_BYTES });
  const entries = text(raw).split('\n').filter(Boolean).flatMap((line) => {
    const [ref, name, object, peeled, head, upstream] = line.split('\0');
    if (!ref || ref.endsWith('/HEAD')) return [];
    return [{ info: refInfo(ref, name || ref, HASH.test(peeled || '') ? peeled! : HASH.test(object || '') ? object! : null), head, upstream }];
  });
  const all = entries.map(({ info }) => info);
  const currentEntry = entries.find(({ head }) => head === '*') ?? null;
  const current = currentEntry ? refInfo('HEAD', currentEntry.info.name, currentEntry.info.revision, 'head') : null;
  const upstreamName = currentEntry?.upstream ?? '';
  const upstream = all.find((entry) => entry.name === upstreamName || entry.id === upstreamName || entry.id === `refs/remotes/${upstreamName}`) ?? null;
  const base = upstream ?? all.find((entry) => entry.kind === 'local' && entry.name !== currentEntry?.info.name && /^(main|master|develop)$/.test(entry.name)) ?? null;
  return { refs: all, current, upstream, base };
}

function cursor(snapshot: string, offset: number) { return Buffer.from(JSON.stringify({ snapshot, offset })).toString('base64url'); }
function parseCursor(value: string, snapshot: string) {
  try {
    const record = CursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
    if (record.snapshot !== snapshot) throw new Error('invalid');
    return record.offset;
  } catch { throw new ServiceError('stale-cursor', 'History cursor is stale', true); }
}

async function resolveCommit(context: ServiceContext, repository: Repository, candidate: string) {
  const matches = text(await required(context, repository, ['rev-parse', `--disambiguate=${candidate}`])).trim().split('\n').filter((value) => HASH.test(value));
  const commits: string[] = [];
  for (const match of matches) {
    const result = await context.runGit(repository.root, ['cat-file', '-t', match]);
    if (result.exitCode === 0 && text(result.stdout).trim() === 'commit') commits.push(match);
    else if (result.exitCode === 0 && text(result.stdout).trim() === 'tag') {
      const peeled = await context.runGit(repository.root, ['rev-parse', '--verify', '--end-of-options', `${match}^{commit}`]);
      if (peeled.exitCode === 0 && HASH.test(text(peeled.stdout).trim())) commits.push(text(peeled.stdout).trim());
    }
  }
  const unique = [...new Set(commits)];
  return { read: 'resolve-commit' as const, commit: unique.length === 1 ? unique[0]! : null, ambiguous: unique.length > 1 };
}

async function refs(context: ServiceContext, repository: Repository, request: Extract<ReadRequest, { read: 'refs' }>) {
  const all = await fullInternalRefs(context, repository);
  const offset = request.cursor ? parseCursor(request.cursor, repository.snapshot) : 0;
  if (offset > all.refs.length) throw new ServiceError('stale-cursor', 'References cursor is stale', true);
  const limit = request.limit ?? DEFAULT_REF_PAGE_SIZE;
  let end = Math.min(offset + limit, all.refs.length);
  while (end > offset) {
    const nextCursor = end < all.refs.length ? cursor(repository.snapshot, end) : null;
    const page = { read: 'refs' as const, refs: all.refs.slice(offset, end), current: all.current, upstream: all.upstream, base: all.base, nextCursor };
    if (Buffer.byteLength(JSON.stringify(page)) <= MAX_REF_PAGE_BYTES) return page;
    end -= 1;
  }
  if (offset === all.refs.length) return { read: 'refs' as const, refs: [], current: all.current, upstream: all.upstream, base: all.base, nextCursor: null };
  throw new ServiceError('unsupported', 'A reference metadata entry exceeds the response budget');
}

async function verifyCommitish(context: ServiceContext, repository: Repository, ref: string) {
  validateRef(ref);
  const result = await context.runGit(repository.root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
  if (result.exitCode !== 0) fail('not-found', `Unknown commit reference: ${ref}`);
  return text(result.stdout).trim();
}

function chunk(repository: Repository, value: Buffer, offset: number, requested: number) {
  if (offset > value.byteLength) fail('invalid-request', 'Chunk offset is beyond the diff');
  let end = Math.min(value.byteLength, offset + Math.min(requested, 200_000));
  while (end > offset && end < value.byteLength && (value[end]! & 0xc0) === 0x80) end -= 1;
  let low = offset; let high = end;
  while (low < high) {
    let candidate = Math.ceil((low + high) / 2);
    while (candidate > offset && candidate < value.byteLength && (value[candidate]! & 0xc0) === 0x80) candidate -= 1;
    if (Buffer.byteLength(JSON.stringify({ text: value.subarray(offset, candidate).toString('utf8') })) <= 230_000) low = candidate;
    else high = candidate - 1;
  }
  end = low;
  const slice = value.subarray(offset, end);
  const complete = end >= value.byteLength;
  const isBinary = value.includes(0) || value.includes(Buffer.from('GIT binary patch')) || value.includes(Buffer.from('Binary files '));
  return { snapshot: repository.snapshot, chunkId: id(`${repository.snapshot}:${createHash('sha256').update(value).digest('hex')}`), offset, totalBytes: value.byteLength, complete, text: isBinary ? slice.toString('utf8').split('GIT binary patch')[0]!.trimEnd() : slice.toString('utf8'), isBinary, truncated: !complete };
}

function parseFiles(raw: string) {
  const tokens = raw.split('\0'); const files: Array<{ path: string; previousPath: string | null; status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T'; insertions: number; deletions: number; isBinary: boolean }> = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++] ?? ''; if (!status) continue;
    const rename = /^[RC]/.test(status); const previousPath = rename ? tokens[index++] ?? '' : null; const path = tokens[index++] ?? '';
    if (!path) continue;
    const kind = status[0];
    if (kind !== 'A' && kind !== 'M' && kind !== 'D' && kind !== 'R' && kind !== 'C' && kind !== 'T') fail('unsupported', 'Git returned an unsupported file status');
    files.push({ path, previousPath: previousPath || null, status: kind, insertions: 0, deletions: 0, isBinary: false });
  }
  return files;
}

function applyStats(files: ReturnType<typeof parseFiles>, raw: string) {
  const stats = new Map<string, { insertions: number; deletions: number; isBinary: boolean }>();
  const tokens = raw.split('\0');
  for (let index = 0; index < tokens.length; index += 1) {
    const entry = tokens[index] ?? ''; const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(entry); if (!match) continue;
    let path = match[3] ?? '';
    if (!path) { index += 2; path = tokens[index] ?? ''; }
    stats.set(path, { insertions: match[1] === '-' ? 0 : Number(match[1]), deletions: match[2] === '-' ? 0 : Number(match[2]), isBinary: match[1] === '-' || match[2] === '-' });
  }
  return files.map((file) => ({ ...file, ...stats.get(file.path) }));
}

async function changedFiles(context: ServiceContext, repository: Repository, args: readonly string[]) {
  const [names, stats] = await Promise.all([required(context, repository, ['diff', '--name-status', '-z', '-M', '-C', ...args]), required(context, repository, ['diff', '--numstat', '-z', '-M', '-C', ...args])]);
  return applyStats(parseFiles(text(names)), text(stats));
}

export async function readRepository(context: ServiceContext, repository: Repository, request: ReadRequest): Promise<ReadData> {
  assertSnapshot(repository, request);
  if (request.read === 'status') return { read: 'status', status: await status(context, repository) };
  if (request.read === 'working-tree') {
    const raw = await required(context, repository, ['stash', 'list', '--format=%gd%x00%H%x00%gs%x00']);
    const tokens = text(raw).split('\0'); const stashes = [];
    for (let index = 0; index + 2 < tokens.length; index += 3) { const ref = (tokens[index] ?? '').trimStart(); if (ref && HASH.test(tokens[index + 1] ?? '')) stashes.push({ ref, hash: tokens[index + 1]!, message: tokens[index + 2] ?? '' }); }
    return { read: 'working-tree', status: await status(context, repository), stashes };
  }
  if (request.read === 'refs') return refs(context, repository, request);
  if (request.read === 'resolve-commit') return resolveCommit(context, repository, request.candidate);
  if (request.read === 'merge-base') {
    await Promise.all(request.refs.map((ref) => verifyCommitish(context, repository, ref)));
    const result = await context.runGit(repository.root, ['merge-base', '--', request.refs[0]!, request.refs[1]!]);
    if (result.exitCode === 1) return { read: 'merge-base', mergeBase: null };
    if (result.exitCode !== 0) await requireGit(context.runGit, repository.root, ['merge-base', '--', request.refs[0]!, request.refs[1]!]);
    const mergeBase = text(result.stdout).trim(); return { read: 'merge-base', mergeBase: HASH.test(mergeBase) ? mergeBase : null };
  }
  if (request.read === 'history') {
    const offset = request.cursor ? parseCursor(request.cursor, repository.snapshot) : 0;
    const all = request.refs.length === 1 && request.refs[0] === '*';
    if (!all) await Promise.all(request.refs.map((ref) => verifyCommitish(context, repository, ref)));
    const raw = await required(context, repository, ['log', '--topo-order', '--decorate=full', '--date=iso-strict', `--skip=${offset}`, `--max-count=${request.limit + 1}`, '--pretty=format:%H%x00%P%x00%an%x00%ae%x00%aI%x00%s%x00%B%x00%D%x00', ...(all ? ['--all'] : request.refs), '--']);
    const refsResponse = await fullInternalRefs(context, repository); const byId = new Map(refsResponse.refs.map((entry) => [entry.id, entry]));
    const fields = text(raw).split('\0'); const items = [];
    for (let field = 0; field + 7 < fields.length; field += 8) {
      const [commit = '', parents = '', author = '', authorEmail = '', timestamp = '', subject = '', message = '', decorations = ''] = fields.slice(field, field + 8);
      const references = decorations.trim().split(',').map((entry) => entry.trim()).flatMap((entry) => {
        if (entry === 'HEAD' || entry.startsWith('HEAD ->')) return refsResponse.current ? [refsResponse.current] : [];
        const reference = byId.get(entry.replace(/^tag: /, ''));
        return reference ? [reference] : [];
      });
      items.push({ id: commit.trimStart(), parentIds: parents ? parents.split(' ').filter(Boolean) : [], author, authorEmail, timestamp, subject, message, statistics: { files: 0, insertions: 0, deletions: 0 }, references });
    }
    const hasMore = items.length > request.limit; return { read: 'history', items: hasMore ? items.slice(0, request.limit) : items, nextCursor: hasMore ? cursor(repository.snapshot, offset + request.limit) : null, hasMore, refsSnapshot: repository.snapshot };
  }
  if (request.read === 'working-tree-diff') {
    validatePath(request.path);
    let output: Buffer;
    if (request.scope === 'staged') output = await required(context, repository, ['diff', '--cached', '--binary', '--no-ext-diff', '--', request.path]);
    else {
      const tracked = await context.runGit(repository.root, ['ls-files', '--error-unmatch', '--', request.path]);
      if (tracked.exitCode === 0) output = await required(context, repository, ['diff', '--binary', '--no-ext-diff', '--', request.path]);
      else { const absolute = join(repository.root, request.path); const stat = await lstat(absolute); if (stat.isSymbolicLink()) fail('unsupported', 'Untracked symlinks cannot be previewed'); const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null'; const result = await context.runGit(repository.root, ['diff', '--no-index', '--binary', '--no-ext-diff', '--', nullDevice, request.path]); if (result.exitCode !== 0 && result.exitCode !== 1) await requireGit(context.runGit, repository.root, ['diff', '--no-index', '--binary', '--no-ext-diff', '--', nullDevice, request.path]); output = result.stdout; }
    }
    return { read: 'working-tree-diff', chunk: chunk(repository, output, request.offset, request.limit) };
  }
  if (request.read === 'hunks') {
    validatePath(request.path); const patch = text(await required(context, repository, ['diff', ...(request.scope === 'staged' ? ['--cached'] : []), '--no-ext-diff', '--unified=0', '--', request.path]));
    const matches = [...patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/gm)]; const header = patch.slice(0, matches[0]?.index ?? patch.length);
    const hunks = matches.map((match, index) => { const body = patch.slice(match.index, matches[index + 1]?.index ?? patch.length); const key = id(`${repository.id}:${repository.snapshot}:${request.path}:${request.scope}:${index}:${match[0]}`); context.rememberHunk(key, { repositoryId: repository.id, snapshot: repository.snapshot, path: request.path, scope: request.scope, patch: header + body }); return { id: key, oldStart: Number(match[1]), oldLines: Number(match[2] ?? 1), newStart: Number(match[3]), newLines: Number(match[4] ?? 1) }; });
    return { read: 'hunks', snapshot: repository.snapshot, hunks };
  }
  if (request.read === 'range-files') { await Promise.all([verifyCommitish(context, repository, request.base), verifyCommitish(context, repository, request.head)]); const merge = await context.runGit(repository.root, ['merge-base', request.base, request.head]); const mergeBase = HASH.test(text(merge.stdout).trim()) ? text(merge.stdout).trim() : null; const files = await changedFiles(context, repository, [request.includeWorkingTree ? (mergeBase ?? request.base) : `${request.base}...${request.head}`, '--']); return { read: 'range-files', files, mergeBase }; }
  if (request.read === 'range-diff') { validateRef(request.base); validateRef(request.head); if (request.path) validatePath(request.path); await Promise.all([verifyCommitish(context, repository, request.base), verifyCommitish(context, repository, request.head)]); const merge = await context.runGit(repository.root, ['merge-base', request.base, request.head]); const mergeBase = HASH.test(text(merge.stdout).trim()) ? text(merge.stdout).trim() : null; const output = await required(context, repository, ['diff', '--binary', '--no-ext-diff', request.includeWorkingTree ? (mergeBase ?? request.base) : `${request.base}...${request.head}`, '--', ...(request.path ? [request.path] : [])]); return { read: 'range-diff', chunk: chunk(repository, output, request.offset, request.limit), mergeBase }; }
  if (request.read === 'commit-files') { const commit = await verifyCommitish(context, repository, request.commit); const parent = request.parent ? await verifyCommitish(context, repository, request.parent) : text(await required(context, repository, ['hash-object', '-t', 'tree', '--stdin'])).trim(); return { read: 'commit-files', files: await changedFiles(context, repository, [parent, commit, '--']) }; }
  if (request.read === 'commit-file-preview') { const commit = await verifyCommitish(context, repository, request.commit); if (request.parent) await verifyCommitish(context, repository, request.parent); if (request.originalPath) validatePath(request.originalPath); if (request.modifiedPath) validatePath(request.modifiedPath); const paths = [request.originalPath, request.modifiedPath].filter((value): value is string => Boolean(value)); const args = request.parent ? ['diff', '--binary', '--no-ext-diff', '--find-renames', request.parent, commit, '--', ...paths] : ['show', '--format=', '--root', '--binary', '--no-ext-diff', '--find-renames', commit, '--', ...paths]; const output = await required(context, repository, args); const available = async (spec: string | null) => !spec ? false : (await context.runGit(repository.root, ['cat-file', '-e', spec])).exitCode === 0; return { read: 'commit-file-preview', chunk: chunk(repository, output, request.offset, request.limit), originalAvailable: await available(request.originalPath ? `${request.parent ?? `${commit}^`}:${request.originalPath}` : null), modifiedAvailable: await available(request.modifiedPath ? `${commit}:${request.modifiedPath}` : null) }; }
  throw new ServiceError('unsupported', 'Unsupported read operation');
}
