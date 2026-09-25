import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRepository } from '../../src/service/reads.js';
import type { GitRunOptions, Repository, ServiceContext } from '../../src/service/contracts.js';

const directories: string[] = [];

async function git(cwd: string, args: readonly string[], options?: GitRunOptions) {
  const input = options?.input;
  const child = Bun.spawn(['git', ...args], { cwd, stdin: input ? new Blob([input.toString()]) : undefined, stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).arrayBuffer(), new Response(child.stderr).arrayBuffer()]);
  return { exitCode, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'git-graph-reads-'));
  directories.push(root);
  for (const args of [['init'], ['config', 'user.name', 'Test User'], ['config', 'user.email', 'test@example.test']]) await git(root, args);
  await writeFile(join(root, 'name with spaces.txt'), 'one\n');
  await git(root, ['add', '--', 'name with spaces.txt']);
  await git(root, ['commit', '-m', 'root subject\n\nroot body']);
  await writeFile(join(root, 'name with spaces.txt'), 'one\ntwo\nthree\n');
  await git(root, ['commit', '-am', 'second subject\n\nsecond body']);
  const head = (await git(root, ['rev-parse', 'HEAD'])).stdout.toString().trim();
  return { root, repository: { id: 'repo', root, commonGitDir: join(root, '.git'), gitDir: join(root, '.git'), snapshot: 'snapshot' } satisfies Repository, head };
}

function context(): ServiceContext {
  const hunks = new Map<string, { repositoryId: string; snapshot: string; path: string; scope: 'staged' | 'unstaged'; patch: string }>();
  return {
    runGit: git,
    refresh: async (repository) => repository.snapshot,
    rememberHunk: (key, hunk) => hunks.set(key, hunk),
    getHunk: (key) => hunks.get(key),
  };
}

afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe('readRepository', () => {
  test('keeps multiline history messages and advances an opaque snapshot cursor', async () => {
    const { repository } = await fixture();
    const first = await readRepository(context(), repository, { version: 1, requestId: 'history-1', operation: 'read', read: 'history', repositoryId: 'repo', snapshot: 'snapshot', refs: ['HEAD'], cursor: null, limit: 1 });
    expect(first.read).toBe('history');
    if (first.read !== 'history') throw new Error('history response expected');
    expect(first.items[0]?.message).toBe('second subject\n\nsecond body\n');
    expect(first.nextCursor).not.toBeNull();
    const second = await readRepository(context(), repository, { version: 1, requestId: 'history-2', operation: 'read', read: 'history', repositoryId: 'repo', snapshot: 'snapshot', refs: ['HEAD'], cursor: first.nextCursor, limit: 1 });
    if (second.read !== 'history') throw new Error('history response expected');
    expect(second.items[0]?.message).toBe('root subject\n\nroot body\n');
  });

  test('pages large ref sets within the response budget without dropping ref metadata', async () => {
    const { root, repository } = await fixture();
    const target = (await git(root, ['rev-parse', 'HEAD'])).stdout.toString().trim();
    const updates = `${Array.from({ length: 2500 }, (_, index) => `update refs/heads/paged-${String(index).padStart(4, '0')}-${'x'.repeat(100)} ${target}`).join('\n')}\n`;
    const updated = await git(root, ['update-ref', '--stdin'], { input: updates });
    expect(updated.exitCode).toBe(0);

    const pages = [];
    let cursor: string | null | undefined;
    do {
      const page = await readRepository(context(), repository, { version: 1, requestId: `refs-${pages.length}`, operation: 'read', read: 'refs', repositoryId: 'repo', snapshot: 'snapshot', cursor, limit: 200 });
      if (page.read !== 'refs') throw new Error('refs response expected');
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(200_000);
      pages.push(page);
      cursor = page.nextCursor;
    } while (cursor);

    const refs = pages.flatMap((page) => page.refs).filter((ref) => ref.id.startsWith('refs/heads/paged-'));
    expect(refs).toHaveLength(2500);
    expect(new Set(refs.map((ref) => ref.id)).size).toBe(2500);
    expect(pages[0]?.current?.id).toBe('HEAD');
  });

  test('returns each selected hunk without including a previous hunk', async () => {
    const { root, repository } = await fixture();
    await writeFile(join(root, 'name with spaces.txt'), 'changed\ntwo\nthree\nlast changed\n');
    const result = await readRepository(context(), repository, { version: 1, requestId: 'hunks', operation: 'read', read: 'hunks', repositoryId: 'repo', snapshot: 'snapshot', path: 'name with spaces.txt', scope: 'unstaged' });
    expect(result.read).toBe('hunks');
    if (result.read !== 'hunks') throw new Error('hunks response expected');
    expect(result.hunks).toHaveLength(2);
  });

  test('preserves porcelain-v2 paths containing spaces, newlines, dashes, and pathspec magic', async () => {
    const { root, repository } = await fixture();
    const names = ['tracked space name.txt', 'tracked\nnewline.txt', '-tracked.txt', ':(literal)tracked.txt'];
    for (const name of names) await writeFile(join(root, name), 'changed\n');
    const result = await readRepository(context(), repository, { version: 1, requestId: 'status', operation: 'read', read: 'status', repositoryId: 'repo', snapshot: 'snapshot' });
    if (result.read !== 'status') throw new Error('status response expected');
    expect(result.status.files.map((file) => file.path)).toEqual(expect.arrayContaining(names));
  });

  test('compares root and child commits against Git objects rather than a dirty working tree', async () => {
    const { root, repository, head } = await fixture();
    const rootCommit = (await git(root, ['rev-parse', 'HEAD~1'])).stdout.toString().trim();
    await writeFile(join(root, 'unrelated dirty.txt'), 'not committed\n');
    const rootFiles = await readRepository(context(), repository, { version: 1, requestId: 'root', operation: 'read', read: 'commit-files', repositoryId: 'repo', snapshot: 'snapshot', commit: rootCommit, parent: null });
    const childFiles = await readRepository(context(), repository, { version: 1, requestId: 'child', operation: 'read', read: 'commit-files', repositoryId: 'repo', snapshot: 'snapshot', commit: head, parent: rootCommit });
    if (rootFiles.read !== 'commit-files' || childFiles.read !== 'commit-files') throw new Error('file responses expected');
    expect(rootFiles.files).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'name with spaces.txt', status: 'A' })]));
    expect(childFiles.files).toEqual([expect.objectContaining({ path: 'name with spaces.txt' })]);
    expect(childFiles.files.map((file) => file.path)).not.toContain('unrelated dirty.txt');
  });
});
