import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { requireGit, ServiceError, type GitRunner, type Repository } from './contracts.js';

const text = (value: Buffer) => value.toString('utf8').trim();
const MAX_SNAPSHOT_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const refreshing = new Map<string, Promise<string>>();

async function updateFile(hash: ReturnType<typeof createHash>, filename: string): Promise<void> {
  const stat = await lstat(filename);
  hash.update(path.basename(filename));
  if (stat.isSymbolicLink()) { hash.update('symlink'); return; }
  if (!stat.isFile()) return;
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filename);
    stream.on('data', (chunk: string | Buffer) => { hash.update(chunk); });
    stream.once('error', reject); stream.once('end', resolve);
  });
}

function changedPaths(status: Buffer): string[] {
  const records = status.toString('utf8').split('\0');
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? '';
    if (!record || record.length < 4) continue;
    const code = record.slice(0, 2);
    if (code === '!!') continue;
    const filename = record.slice(3);
    paths.push(filename);
    if (code[0] === 'R' || code[0] === 'C' || code[1] === 'R' || code[1] === 'C') { const previous = records[index + 1]; if (previous) { paths.push(previous); index += 1; } }
  }
  return paths;
}

export async function refreshRepository(repository: Repository, runGit: GitRunner): Promise<string> {
  let work = refreshing.get(repository.id);
  if (!work) {
    work = refresh(repository, runGit).finally(() => refreshing.delete(repository.id));
    refreshing.set(repository.id, work);
  }
  repository.snapshot = await work;
  return repository.snapshot;
}

async function refresh(repository: Repository, runGit: GitRunner): Promise<string> {
  const headResult = await runGit(repository.root, ['rev-parse', '--verify', 'HEAD']);
  const head = headResult.exitCode === 0 ? text(headResult.stdout) : '';
  if (headResult.exitCode !== 0 && !/needed a single revision|unknown revision/i.test(headResult.stderr.toString('utf8'))) await requireGit(runGit, repository.root, ['rev-parse', '--verify', 'HEAD']);
  const [status, refs, index] = await Promise.all([
    requireGit(runGit, repository.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { maxOutputBytes: MAX_SNAPSHOT_GIT_OUTPUT_BYTES }),
    requireGit(runGit, repository.root, ['for-each-ref', '--format=%(refname)%00%(objectname)'], { maxOutputBytes: MAX_SNAPSHOT_GIT_OUTPUT_BYTES }),
    requireGit(runGit, repository.root, ['ls-files', '--stage', '-z'], { maxOutputBytes: MAX_SNAPSHOT_GIT_OUTPUT_BYTES }),
  ]);
  const hash = createHash('sha256');
  for (const part of [head, status, refs, index]) hash.update(part).update('\0');
  for (const relative of changedPaths(status).sort()) {
    if (relative.includes('\0') || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) continue;
    hash.update(`path:${relative}\0`);
    try { await updateFile(hash, path.join(repository.root, relative)); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; hash.update('missing'); }
  }
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply']) {
    try { await updateFile(hash, path.join(repository.gitDir, marker)); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  }
  repository.snapshot = hash.digest('hex');
  return repository.snapshot;
}

export async function openRepository(directory: string, runGit: GitRunner): Promise<Repository> {
  const requested = await realpath(directory).catch(() => { throw new ServiceError('not-a-repository', 'Directory does not exist'); });
  const root = text(await requireGit(runGit, requested, ['rev-parse', '--show-toplevel']));
  const commonRaw = text(await requireGit(runGit, root, ['rev-parse', '--git-common-dir']));
  const gitRaw = text(await requireGit(runGit, root, ['rev-parse', '--git-dir']));
  const commonGitDir = path.resolve(root, commonRaw);
  const repository: Repository = { id: createHash('sha256').update(`${root}\0${commonGitDir}`).digest('hex').slice(0, 32), root, commonGitDir, gitDir: path.resolve(root, gitRaw), snapshot: '' };
  await refreshRepository(repository, runGit);
  return repository;
}
