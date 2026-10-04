import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRemoteMetadata } from '../../src/service/remotes.js';
import type { GitRunOptions, Repository, ServiceContext } from '../../src/service/contracts.js';

const directories: string[] = [];
type Result = { exitCode: number; stdout: Buffer; stderr: Buffer };
type Runner = (cwd: string, args: readonly string[], options?: GitRunOptions) => Promise<Result>;

async function git(cwd: string, args: readonly string[], options?: GitRunOptions): Promise<Result> {
  const child = Bun.spawn(['git', ...args], { cwd, stdin: options?.input ? new Blob([options.input.toString()]) : undefined, stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).arrayBuffer(), new Response(child.stderr).arrayBuffer()]);
  return { exitCode, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'git-graph-remotes-'));
  directories.push(root);
  for (const args of [['init'], ['config', 'user.name', 'Test'], ['config', 'user.email', 'test@example.test']]) await git(root, args);
  await writeFile(join(root, 'file'), 'content');
  await git(root, ['add', '--', 'file']);
  await git(root, ['commit', '-m', 'initial']);
  return { root, repository: { id: 'repo', root, commonGitDir: join(root, '.git'), gitDir: join(root, '.git'), snapshot: 'snapshot' } satisfies Repository };
}

function context(runGit: Runner = git): ServiceContext {
  const hunks = new Map();
  return { runGit, refresh: async (repository) => repository.snapshot, rememberHunk: (key, hunk) => hunks.set(key, hunk), getHunk: (key) => hunks.get(key) };
}

afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe('readRemoteMetadata', () => {
  test('returns an empty array with no remotes', async () => {
    const { repository } = await fixture();
    expect(await readRemoteMetadata(context(), repository)).toEqual([]);
  });

  test('resolves insteadOf aliases for fetch and push URLs', async () => {
    const { root, repository } = await fixture();
    await git(root, ['config', 'url.https://github.com/.insteadOf', 'gh:']);
    await git(root, ['remote', 'add', 'origin', 'gh:user/repo.git']);
    expect(await readRemoteMetadata(context(), repository)).toEqual([{ name: 'origin', fetchUrl: 'https://github.com/user/repo.git', pushUrl: 'https://github.com/user/repo.git' }]);
  });

  test('resolves pushInsteadOf URLs', async () => {
    const { root, repository } = await fixture();
    await git(root, ['remote', 'add', 'origin', 'https://github.com/user/repo.git']);
    await git(root, ['config', 'url.git@github.com:.pushInsteadOf', 'https://github.com/']);
    expect((await readRemoteMetadata(context(), repository))[0]?.pushUrl).toBe('git@github.com:user/repo.git');
  });

  test.each([1, 128])('fails when resolving a configured URL exits %i', async (exitCode) => {
    const { root, repository } = await fixture();
    await git(root, ['remote', 'add', 'origin', 'https://github.com/user/repo.git']);
    const runner: Runner = async (cwd, args, options) => args[0] === 'remote' && args[1] === 'get-url'
      ? { exitCode, stdout: Buffer.alloc(0), stderr: Buffer.from('secret') }
      : git(cwd, args, options);
    await expect(readRemoteMetadata(context(runner), repository)).rejects.toThrow('Failed to resolve remote URL');
  });

  test('returns null URLs for a remote with neither URL configured', async () => {
    const { root, repository } = await fixture();
    await git(root, ['config', 'remote.empty.fetch', '+refs/heads/*:refs/remotes/empty/*']);
    expect(await readRemoteMetadata(context(), repository)).toEqual([{ name: 'empty', fetchUrl: null, pushUrl: null }]);
  });

  test('removes HTTP credentials and rejects malformed scp credentials', async () => {
    const { root, repository } = await fixture();
    await git(root, ['remote', 'add', 'http', 'https://user:secret@github.com/user/repo.git?token=secret#fragment']);
    await git(root, ['remote', 'add', 'scp', 'git@github.com:user/repo.git']);
    await git(root, ['remote', 'add', 'invalid', 'git@github.com']);
    const remotes = await readRemoteMetadata(context(), repository);
    expect(remotes.find((remote) => remote.name === 'http')?.fetchUrl).toBe('https://github.com/user/repo.git');
    expect(remotes.find((remote) => remote.name === 'scp')?.fetchUrl).toBe('git@github.com:user/repo.git');
    expect(remotes.find((remote) => remote.name === 'invalid')?.fetchUrl).toBeNull();
  });

  test('preserves escaped paths while normalizing Unicode and IPv6 URLs once', async () => {
    const { root, repository } = await fixture();
    await git(root, ['remote', 'add', 'escaped', 'https://github.com/space%20path/repo.git']);
    await git(root, ['remote', 'add', 'unicode', 'https://github.com/café/repo.git']);
    await git(root, ['remote', 'add', 'ipv6', 'https://[2001:db8::1]/repo.git']);

    const remotes = await readRemoteMetadata(context(), repository);
    expect(remotes.find((remote) => remote.name === 'escaped')?.fetchUrl).toBe('https://github.com/space%20path/repo.git');
    expect(remotes.find((remote) => remote.name === 'unicode')?.fetchUrl).toBe('https://github.com/caf%C3%A9/repo.git');
    expect(remotes.find((remote) => remote.name === 'ipv6')?.fetchUrl).toBe('https://[2001:db8::1]/repo.git');
  });

  test('rejects a normalized URL that exceeds the field limit', async () => {
    const { root, repository } = await fixture();
    await git(root, ['remote', 'add', 'origin', `https://github.com/${'€'.repeat(700)}`]);
    await expect(readRemoteMetadata(context(), repository)).rejects.toThrow('Remote URL exceeds the maximum length');
  });
});
