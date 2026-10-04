import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRepository } from '../../src/service/reads.js';
import type { GitRunOptions, Repository, ServiceContext } from '../../src/service/contracts.js';

const directories: string[] = [];

async function git(cwd: string, args: readonly string[], options?: GitRunOptions) {
  const child = Bun.spawn(['git', ...args], { cwd, stdin: options?.input ? new Blob([options.input.toString()]) : undefined, stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).arrayBuffer(), new Response(child.stderr).arrayBuffer()]);
  return { exitCode, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'git-graph-summary-'));
  directories.push(root);
  for (const args of [['init'], ['config', 'user.name', 'Test User'], ['config', 'user.email', 'test@example.test']]) await git(root, args);
  const repository = { id: 'repo', root, commonGitDir: join(root, '.git'), gitDir: join(root, '.git'), snapshot: 'snapshot' } satisfies Repository;
  const context: ServiceContext = { runGit: git, refresh: async (current) => current.snapshot, rememberHunk: () => undefined, getHunk: () => undefined };
  return { root, repository, context };
}

async function summary(context: ServiceContext, repository: Repository, commit: string) {
  return readRepository(context, repository, { version: 1, requestId: 'summary', operation: 'read', read: 'commit-summary', repositoryId: repository.id, snapshot: repository.snapshot, commit });
}

afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe('commit-summary read', () => {
  test('dispatches snapshot-scoped remote metadata reads', async () => {
    const { root, repository, context } = await fixture();
    await git(root, ['remote', 'add', 'origin', 'https://user:secret@example.test/repo.git?token=secret#fragment']);

    const result = await readRepository(context, repository, { version: 1, requestId: 'remotes', operation: 'read', read: 'remotes', repositoryId: repository.id, snapshot: repository.snapshot });
    expect(result).toEqual({ read: 'remotes', remotes: [{ name: 'origin', fetchUrl: 'https://example.test/repo.git', pushUrl: 'https://example.test/repo.git' }] });
  });

  test('uses the empty tree for roots and recognizes binary files', async () => {
    const { root, repository, context } = await fixture();
    await writeFile(join(root, 'text.txt'), 'one\n');
    await writeFile(join(root, 'binary.bin'), Buffer.from([0, 1, 2]));
    await git(root, ['add', '--', 'text.txt', 'binary.bin']);
    await git(root, ['commit', '-m', 'root subject\n\nroot body']);
    const commit = (await git(root, ['rev-parse', 'HEAD'])).stdout.toString().trim();

    const result = await summary(context, repository, commit);
    if (result.read !== 'commit-summary') throw new Error('summary expected');
    expect(result.commit).toMatchObject({ id: commit, parentIds: [], subject: 'root subject', message: 'root subject\n\nroot body\n', authorEmail: 'test@example.test' });
    expect(result.commit.statistics).toEqual({ files: 2, insertions: 1, deletions: 0 });
    expect(result.messageTruncated).toBe(false);
  });

  test('keeps NUL metadata framing when configured to show SSH signatures', async () => {
    const { root, repository, context } = await fixture();
    const signingKey = join(root, 'signing-key');
    const allowedSigners = join(root, 'allowed-signers');
    await git(root, ['config', 'gpg.format', 'ssh']);
    await git(root, ['config', 'user.signingkey', signingKey]);
    await git(root, ['config', 'gpg.ssh.allowedSignersFile', allowedSigners]);
    await git(root, ['config', 'log.showSignature', 'true']);
    const key = Bun.spawn(['ssh-keygen', '-q', '-N', '', '-f', signingKey], { stdout: 'pipe', stderr: 'pipe' });
    expect(await key.exited).toBe(0);
    const publicKey = await Bun.file(`${signingKey}.pub`).text();
    await writeFile(allowedSigners, `test@example.test ${publicKey}`);
    await writeFile(join(root, 'signed.txt'), 'signed\n');
    await git(root, ['add', '--', 'signed.txt']);
    await git(root, ['commit', '-S', '-m', 'signed commit']);
    const commit = (await git(root, ['rev-parse', 'HEAD'])).stdout.toString().trim();

    const result = await summary(context, repository, commit);
    expect(result).toMatchObject({ read: 'commit-summary', commit: { id: commit, subject: 'signed commit' } });
  });

  test('separates the commit revision from an untracked file named for its ID', async () => {
    const { root, repository, context } = await fixture();
    await writeFile(join(root, 'file.txt'), 'one\n');
    await git(root, ['add', '--', 'file.txt']);
    await git(root, ['commit', '-m', 'first']);
    const commit = (await git(root, ['rev-parse', 'HEAD'])).stdout.toString().trim();
    await writeFile(join(root, commit), 'untracked');

    const result = await summary(context, repository, commit);
    expect(result).toMatchObject({ read: 'commit-summary', commit: { id: commit, subject: 'first' } });
  });

  test('uses the first parent for merge summaries and counts renames once', async () => {
    const { root, repository, context } = await fixture();
    await writeFile(join(root, 'before.txt'), 'one\n');
    await git(root, ['add', '--', 'before.txt']);
    await git(root, ['commit', '-m', 'root']);
    await git(root, ['checkout', '-b', 'side']);
    await writeFile(join(root, 'side.txt'), 'side\n'); await git(root, ['add', '--', 'side.txt']); await git(root, ['commit', '-m', 'side']);
    await git(root, ['checkout', '-']);
    await git(root, ['mv', 'before.txt', 'after.txt']); await git(root, ['commit', '-m', 'rename']);
    const firstParent = (await git(root, ['rev-parse', 'HEAD'])).stdout.toString().trim();
    await git(root, ['merge', '--no-ff', 'side', '-m', 'merge side']);
    const merge = (await git(root, ['rev-parse', 'HEAD'])).stdout.toString().trim();

    const renamed = await summary(context, repository, firstParent);
    const merged = await summary(context, repository, merge);
    if (renamed.read !== 'commit-summary' || merged.read !== 'commit-summary') throw new Error('summaries expected');
    expect(renamed.commit.statistics.files).toBe(1);
    expect(merged.commit.parentIds).toHaveLength(2);
    expect(merged.commit.statistics).toEqual({ files: 1, insertions: 1, deletions: 0 });
  });

  test('counts a renamed newline path once', async () => {
    const { root, repository, context } = await fixture();
    const before = 'before\nname.txt'; const after = 'after\nname.txt';
    await writeFile(join(root, before), 'one\n'); await git(root, ['add', '--', before]); await git(root, ['commit', '-m', 'root']);
    await git(root, ['mv', before, after]); await git(root, ['commit', '-m', 'rename newline path']);
    const commit = (await git(root, ['rev-parse', 'HEAD'])).stdout.toString().trim();

    const result = await summary(context, repository, commit);
    if (result.read !== 'commit-summary') throw new Error('summary expected');
    expect(result.commit.statistics).toEqual({ files: 1, insertions: 0, deletions: 0 });

    await writeFile(join(root, after), 'one\ntwo\n'); await git(root, ['commit', '-am', 'modify newline path']);
    const modified = (await git(root, ['rev-parse', 'HEAD'])).stdout.toString().trim();
    const changed = await summary(context, repository, modified);
    if (changed.read !== 'commit-summary') throw new Error('summary expected');
    expect(changed.commit.statistics).toEqual({ files: 1, insertions: 1, deletions: 0 });
  });

  test('rejects malformed numeric stats instead of returning an empty success', async () => {
    const { root, repository, context } = await fixture();
    await writeFile(join(root, 'file.txt'), 'one\n'); await git(root, ['add', '--', 'file.txt']); await git(root, ['commit', '-m', 'first']);
    const commit = (await git(root, ['rev-parse', 'HEAD'])).stdout.toString().trim();
    const malformed: ServiceContext = { ...context, runGit: async (cwd, args, options) => args[0] === 'diff' ? { exitCode: 0, stdout: Buffer.from('not-numstat\0'), stderr: Buffer.alloc(0) } : git(cwd, args, options) };

    await expect(summary(malformed, repository, commit)).rejects.toThrow('malformed numeric statistics');
  });

  test('rejects malformed commit metadata framing and identity', async () => {
    const { repository, context } = await fixture();
    const commit = 'a'.repeat(40); const metadata = [`${'b'.repeat(40)}`, '', 'Author', 'author@example.test', '2026-10-04T12:00:00+00:00', 'subject', 'body', 'extra', ''].join('\0');
    const malformed: ServiceContext = { ...context, runGit: async (_cwd, args) => {
      if (args[0] === 'rev-parse') return { exitCode: 0, stdout: Buffer.from(`${commit}\n`), stderr: Buffer.alloc(0) };
      if (args[0] === 'show') return { exitCode: 0, stdout: Buffer.from(metadata), stderr: Buffer.alloc(0) };
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    } };

    await expect(summary(malformed, repository, commit)).rejects.toThrow('invalid commit metadata');
  });

  test('rejects metadata with an invalid wire timestamp', async () => {
    const { repository, context } = await fixture();
    const commit = 'a'.repeat(40); const metadata = [commit, '', 'Author', 'author@example.test', 'not-a-timestamp', 'subject', 'body'].join('\0') + '\0\n';
    const malformed: ServiceContext = { ...context, runGit: async (_cwd, args) => {
      if (args[0] === 'rev-parse') return { exitCode: 0, stdout: Buffer.from(`${commit}\n`), stderr: Buffer.alloc(0) };
      if (args[0] === 'show') return { exitCode: 0, stdout: Buffer.from(metadata), stderr: Buffer.alloc(0) };
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    } };

    await expect(summary(malformed, repository, commit)).rejects.toThrow('invalid commit metadata');
  });

  test('reports oversized commit metadata as unsupported', async () => {
    const { repository, context } = await fixture();
    const commit = 'a'.repeat(40);
    const metadata = [commit, '', 'A'.repeat(513), 'author@example.test', '2026-10-04T12:00:00+00:00', 'subject', 'body'].join('\0') + '\0\n';
    const oversized: ServiceContext = { ...context, runGit: async (_cwd, args) => {
      if (args[0] === 'rev-parse') return { exitCode: 0, stdout: Buffer.from(`${commit}\n`), stderr: Buffer.alloc(0) };
      if (args[0] === 'show') return { exitCode: 0, stdout: Buffer.from(metadata), stderr: Buffer.alloc(0) };
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    } };

    await expect(summary(oversized, repository, commit)).rejects.toThrow('Commit metadata exceeds the maximum length');
  });

  test('rejects stale snapshots and unknown commits', async () => {
    const { root, repository, context } = await fixture();
    await writeFile(join(root, 'file.txt'), 'one\n'); await git(root, ['add', '--', 'file.txt']); await git(root, ['commit', '-m', 'first']);
    const commit = (await git(root, ['rev-parse', 'HEAD'])).stdout.toString().trim();
    await expect(readRepository(context, repository, { version: 1, requestId: 'stale', operation: 'read', read: 'commit-summary', repositoryId: repository.id, snapshot: 'old', commit })).rejects.toThrow('Read snapshot is stale');
    await expect(summary(context, repository, 'f'.repeat(40))).rejects.toThrow('Unknown commit reference');
  });

  test('truncates a Unicode body without splitting a code point', async () => {
    const { root, repository, context } = await fixture();
    await writeFile(join(root, 'file.txt'), 'one\n'); await git(root, ['add', '--', 'file.txt']);
    await git(root, ['commit', '-m', `subject\n\n${'🙂'.repeat(60_000)}`]);
    const commit = (await git(root, ['rev-parse', 'HEAD'])).stdout.toString().trim();

    const result = await summary(context, repository, commit);
    if (result.read !== 'commit-summary') throw new Error('summary expected');
    expect(result.messageTruncated).toBe(true);
    expect(Buffer.from(result.commit.message, 'utf8').toString('utf8')).toBe(result.commit.message);
  });

  test('keeps escaped Unicode summaries within the advertised serialized budget', async () => {
    const { root, repository, context } = await fixture();
    await writeFile(join(root, 'file.txt'), 'one\n'); await git(root, ['add', '--', 'file.txt']);
    await git(root, ['commit', '-m', `subject\n\n${'"\n🙂'.repeat(50_000)}`]);
    const commit = (await git(root, ['rev-parse', 'HEAD'])).stdout.toString().trim();

    const result = await summary(context, repository, commit);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(200_000);
    if (result.read !== 'commit-summary') throw new Error('summary expected');
    expect(result.messageTruncated).toBe(true);
    expect(Buffer.from(result.commit.message, 'utf8').toString('utf8')).toBe(result.commit.message);
  });
});
