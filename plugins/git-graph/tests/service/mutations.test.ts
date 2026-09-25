import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mutateRepository } from '../../src/service/mutations.js';
import type { GitResult, Repository, ServiceContext } from '../../src/service/contracts.js';

const directories: string[] = [];
const exists = (path: string) => lstat(path).then(() => true).catch(() => false);

async function git(directory: string, ...args: string[]) {
  const process = Bun.spawn(['git', ...args], { cwd: directory, stdout: 'pipe', stderr: 'pipe' });
  const exitCode = await process.exited;
  const stdout = Buffer.from(await new Response(process.stdout).arrayBuffer());
  const stderr = Buffer.from(await new Response(process.stderr).arrayBuffer());
  if (exitCode !== 0) throw new Error(stderr.toString());
  return stdout.toString();
}

async function createRepository() {
  const root = await mkdtemp(join(tmpdir(), 'git-graph-mutations-'));
  directories.push(root);
  await git(root, 'init');
  await git(root, 'config', 'user.name', 'Test User');
  await git(root, 'config', 'user.email', 'test@example.test');
  await writeFile(join(root, 'tracked.txt'), 'one\ntwo\nthree\n');
  await git(root, 'add', '--', 'tracked.txt');
  await git(root, 'commit', '-m', 'initial');
  return root;
}

function runner(cwd: string, args: readonly string[], options?: { input?: string | Buffer }): Promise<GitResult> {
  const process = Bun.spawn(['git', ...args], { cwd, stdin: options?.input ? 'pipe' : 'ignore', stdout: 'pipe', stderr: 'pipe' });
  if (options?.input && process.stdin) {
    process.stdin.write(options.input);
    process.stdin.end();
  }
  return process.exited.then(async (exitCode) => ({
    exitCode,
    stdout: Buffer.from(await new Response(process.stdout).arrayBuffer()),
    stderr: Buffer.from(await new Response(process.stderr).arrayBuffer()),
  }));
}

async function context(root: string): Promise<{ context: ServiceContext; repository: Repository }> {
  const hunks = new Map<string, { repositoryId: string; snapshot: string; path: string; scope: 'staged' | 'unstaged'; patch: string }>();
  const repository: Repository = { id: 'test', root, gitDir: join(root, '.git'), commonGitDir: join(root, '.git'), snapshot: '' };
  const refresh = async (current: Repository) => {
    const status = await git(current.root, 'status', '--porcelain=v2', '-z');
    const staged = await git(current.root, 'diff', '--cached', '--binary', '--no-ext-diff');
    const unstaged = await git(current.root, 'diff', '--binary', '--no-ext-diff');
    current.snapshot = createHash('sha256').update(`${status}\0${staged}\0${unstaged}`).digest('hex');
    return current.snapshot;
  };
  await refresh(repository);
  return { context: { runGit: runner, refresh, rememberHunk: (key, hunk) => hunks.set(key, hunk), getHunk: (key) => hunks.get(key) }, repository };
}

afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe('repository mutations', () => {
  test('stages a dash-prefixed literal path without treating it as an option', async () => {
    const root = await createRepository();
    await writeFile(join(root, '-draft.txt'), 'draft\n');
    const fixture = await context(root);

    await mutateRepository(fixture.context, fixture.repository, { mutation: 'stage-path', path: '-draft.txt' });

    expect(await git(root, 'diff', '--cached', '--name-only')).toBe('-draft.txt\n');
  });

  test('applies only the selected second hunk', async () => {
    const root = await createRepository();
    await writeFile(join(root, 'tracked.txt'), 'first\ntwo\nthird\n');
    const fixture = await context(root);
    const patch = await git(root, 'diff', '--no-ext-diff', '--unified=0', '--', 'tracked.txt');
    const firstHunkStart = patch.indexOf('@@');
    const secondStart = patch.indexOf('\n@@ ', firstHunkStart + 1) + 1;
    fixture.context.rememberHunk('second', { repositoryId: fixture.repository.id, snapshot: fixture.repository.snapshot, path: 'tracked.txt', scope: 'unstaged', patch: patch.slice(0, firstHunkStart) + patch.slice(secondStart) });

    await mutateRepository(fixture.context, fixture.repository, { mutation: 'stage-hunk', path: 'tracked.txt', hunkId: 'second' });

    expect(await git(root, 'diff', '--cached', '--', 'tracked.txt')).toContain('+third');
    expect(await git(root, 'diff', '--cached', '--', 'tracked.txt')).not.toContain('+first');
  });

  test('does not accept traversal as a pathspec', async () => {
    const root = await createRepository();
    const fixture = await context(root);

    await expect(mutateRepository(fixture.context, fixture.repository, { mutation: 'stage-path', path: '../outside.txt' })).rejects.toMatchObject({ code: 'invalid-request' });

    expect(await git(root, 'diff', '--cached', '--name-only')).toBe('');
  });

  test('does not follow a repository symlink to stage an outside path', async () => {
    const root = await createRepository();
    const outside = await mkdtemp(join(tmpdir(), 'git-graph-outside-'));
    directories.push(outside);
    await writeFile(join(outside, 'outside.txt'), 'outside\n');
    await symlink(outside, join(root, 'linked'));
    const fixture = await context(root);

    await expect(mutateRepository(fixture.context, fixture.repository, { mutation: 'stage-path', path: 'linked/outside.txt' })).rejects.toMatchObject({ code: 'invalid-request' });

    expect(await git(root, 'diff', '--cached', '--name-only')).toBe('');
  });

  test('unstages an unborn repository without requiring HEAD', async () => {
    const root = await mkdtemp(join(tmpdir(), 'git-graph-unborn-'));
    directories.push(root);
    await git(root, 'init');
    await writeFile(join(root, 'new.txt'), 'new\n');
    await git(root, 'add', '--', 'new.txt');
    const fixture = await context(root);

    await mutateRepository(fixture.context, fixture.repository, { mutation: 'unstage-path', path: 'new.txt' });

    expect(await git(root, 'status', '--porcelain')).toBe('?? new.txt\n');
  });

  test('unstages a selected tracked path without changing its working copy', async () => {
    const root = await createRepository();
    await writeFile(join(root, 'tracked.txt'), 'staged copy\n');
    await git(root, 'add', '--', 'tracked.txt');
    const fixture = await context(root);

    await mutateRepository(fixture.context, fixture.repository, { mutation: 'unstage-path', path: 'tracked.txt' });

    expect(await Bun.file(join(root, 'tracked.txt')).text()).toBe('staged copy\n');
    expect(await git(root, 'diff', '--cached', '--name-only')).toBe('');
  });

  test('discards only the requested working-tree path and removes selected untracked files', async () => {
    const root = await createRepository();
    await writeFile(join(root, 'tracked.txt'), 'changed\n');
    await writeFile(join(root, 'remove-me.txt'), 'remove\n');
    await writeFile(join(root, 'keep-me.txt'), 'keep\n');
    const fixture = await context(root);

    await mutateRepository(fixture.context, fixture.repository, { mutation: 'discard-path', path: 'tracked.txt', scope: 'working' });
    await mutateRepository(fixture.context, fixture.repository, { mutation: 'discard-path', path: 'remove-me.txt', scope: 'all' });

    expect(await Bun.file(join(root, 'tracked.txt')).text()).toBe('one\ntwo\nthree\n');
    expect(await Bun.file(join(root, 'remove-me.txt')).exists()).toBe(false);
    expect(await Bun.file(join(root, 'keep-me.txt')).exists()).toBe(true);
  });

  test('discards a newly staged file from both index and working tree', async () => {
    const root = await createRepository();
    await writeFile(join(root, 'new.txt'), 'new\n');
    await git(root, 'add', '--', 'new.txt');
    const fixture = await context(root);

    await mutateRepository(fixture.context, fixture.repository, { mutation: 'discard-path', path: 'new.txt', scope: 'all' });

    expect(await Bun.file(join(root, 'new.txt')).exists()).toBe(false);
    expect(await git(root, 'status', '--porcelain')).toBe('');
  });

  test('commits with the repository identity and creates validated branch and tag targets', async () => {
    const root = await createRepository();
    await writeFile(join(root, 'tracked.txt'), 'committed\n');
    const fixture = await context(root);
    await mutateRepository(fixture.context, fixture.repository, { mutation: 'stage-path', path: 'tracked.txt' });
    await mutateRepository(fixture.context, fixture.repository, { mutation: 'commit', message: 'configured identity' });
    const commit = (await git(root, 'rev-parse', 'HEAD')).trim();

    await mutateRepository(fixture.context, fixture.repository, { mutation: 'create-branch', name: 'feature/validated', startPoint: commit });
    await mutateRepository(fixture.context, fixture.repository, { mutation: 'create-tag', name: 'v-test', commit });

    expect((await git(root, 'show', '-s', '--format=%an <%ae>', 'HEAD')).trim()).toBe('Test User <test@example.test>');
    expect((await git(root, 'rev-parse', 'refs/heads/feature/validated')).trim()).toBe(commit);
    expect((await git(root, 'rev-parse', 'refs/tags/v-test')).trim()).toBe(commit);
  });

  test('requires hard-reset confirmation before changing HEAD', async () => {
    const root = await createRepository();
    const fixture = await context(root);
    const commit = (await git(root, 'rev-parse', 'HEAD')).trim();

    await expect(mutateRepository(fixture.context, fixture.repository, { mutation: 'reset', commit, mode: 'hard', force: false })).rejects.toMatchObject({ code: 'invalid-request' });

    expect((await git(root, 'rev-parse', 'HEAD')).trim()).toBe(commit);
  });

  test('performs a confirmed hard reset to a resolved commit', async () => {
    const root = await createRepository();
    const initial = (await git(root, 'rev-parse', 'HEAD')).trim();
    await writeFile(join(root, 'tracked.txt'), 'later\n');
    await git(root, 'commit', '-am', 'later');
    const fixture = await context(root);

    await mutateRepository(fixture.context, fixture.repository, { mutation: 'reset', commit: initial, mode: 'hard', force: true });

    expect((await git(root, 'rev-parse', 'HEAD')).trim()).toBe(initial);
    expect(await Bun.file(join(root, 'tracked.txt')).text()).toBe('one\ntwo\nthree\n');
  });

  test('preserves merge conflict markers until the user aborts recovery', async () => {
    const root = await createRepository();
    const initialBranch = (await git(root, 'symbolic-ref', '--short', 'HEAD')).trim();
    await git(root, 'checkout', '-b', 'other');
    await writeFile(join(root, 'tracked.txt'), 'other\n');
    await git(root, 'commit', '-am', 'other change');
    await git(root, 'checkout', initialBranch);
    await writeFile(join(root, 'tracked.txt'), 'main\n');
    await git(root, 'commit', '-am', 'main change');
    const fixture = await context(root);

    await expect(mutateRepository(fixture.context, fixture.repository, { mutation: 'merge', branch: 'other' })).rejects.toMatchObject({ code: 'conflict' });
    expect(await Bun.file(join(root, '.git', 'MERGE_HEAD')).exists()).toBe(true);
    await mutateRepository(fixture.context, fixture.repository, { mutation: 'merge-abort' });

    expect(await Bun.file(join(root, '.git', 'MERGE_HEAD')).exists()).toBe(false);
  });

  test('accepts a numbered stash reference after resolving it', async () => {
    const root = await createRepository();
    await writeFile(join(root, 'tracked.txt'), 'stashed\n');
    const fixture = await context(root);
    await mutateRepository(fixture.context, fixture.repository, { mutation: 'stash-create', message: 'test stash', includeUntracked: false });

    await mutateRepository(fixture.context, fixture.repository, { mutation: 'stash-apply', ref: 'stash@{0}' });

    expect(await Bun.file(join(root, 'tracked.txt')).text()).toBe('stashed\n');
  });

  test('pushes only to a configured disposable remote', async () => {
    const root = await createRepository();
    const remote = await mkdtemp(join(tmpdir(), 'git-graph-bare-'));
    directories.push(remote);
    await git(remote, 'init', '--bare');
    await git(root, 'remote', 'add', 'origin', remote);
    const branch = (await git(root, 'symbolic-ref', '--short', 'HEAD')).trim();
    const fixture = await context(root);

    await mutateRepository(fixture.context, fixture.repository, { mutation: 'push', remote: 'origin', branch, forceWithLease: false });

    expect((await git(remote, 'show-ref', '--verify', `refs/heads/${branch}`)).length).toBeGreaterThan(0);
  });

  test('leaves rebase state visible until recovery aborts it', async () => {
    const root = await createRepository();
    const initialBranch = (await git(root, 'symbolic-ref', '--short', 'HEAD')).trim();
    await git(root, 'checkout', '-b', 'topic');
    await writeFile(join(root, 'tracked.txt'), 'topic\n');
    await git(root, 'commit', '-am', 'topic change');
    await git(root, 'checkout', initialBranch);
    await writeFile(join(root, 'tracked.txt'), 'base\n');
    await git(root, 'commit', '-am', 'base change');
    const fixture = await context(root);
    await git(root, 'checkout', 'topic');

    await expect(mutateRepository(fixture.context, fixture.repository, { mutation: 'rebase', onto: initialBranch })).rejects.toMatchObject({ code: 'conflict' });
    expect((await exists(join(root, '.git', 'rebase-merge'))) || (await exists(join(root, '.git', 'rebase-apply')))).toBe(true);
    await mutateRepository(fixture.context, fixture.repository, { mutation: 'rebase-abort' });

    expect((await exists(join(root, '.git', 'rebase-merge'))) || (await exists(join(root, '.git', 'rebase-apply')))).toBe(false);
  });

  test('leaves revert conflict state visible until recovery aborts it', async () => {
    const root = await createRepository();
    await writeFile(join(root, 'tracked.txt'), 'target\n');
    await git(root, 'commit', '-am', 'target change');
    const target = (await git(root, 'rev-parse', 'HEAD')).trim();
    await writeFile(join(root, 'tracked.txt'), 'later\n');
    await git(root, 'commit', '-am', 'later change');
    const fixture = await context(root);

    await expect(mutateRepository(fixture.context, fixture.repository, { mutation: 'revert', commit: target })).rejects.toMatchObject({ code: 'conflict' });
    expect(await Bun.file(join(root, '.git', 'REVERT_HEAD')).exists()).toBe(true);
    await mutateRepository(fixture.context, fixture.repository, { mutation: 'revert-abort' });

    expect(await Bun.file(join(root, '.git', 'REVERT_HEAD')).exists()).toBe(false);
  });
});
