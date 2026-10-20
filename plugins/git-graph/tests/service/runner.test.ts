import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitRunner } from '../../src/service/runner.js';

const directories: string[] = [];

async function git(directory: string, args: string[], environment: NodeJS.ProcessEnv = process.env) {
  const process = Bun.spawn(['git', ...args], { cwd: directory, env: environment, stdout: 'pipe', stderr: 'pipe' });
  const exitCode = await process.exited;
  return { exitCode, stderr: await new Response(process.stderr).text(), stdout: await new Response(process.stdout).text() };
}

async function repository() {
  const directory = await mkdtemp(join(tmpdir(), 'git-graph-runner-'));
  directories.push(directory);
  await git(directory, ['init']);
  await git(directory, ['config', 'user.name', 'Test User']);
  await git(directory, ['config', 'user.email', 'test@example.test']);
  await writeFile(join(directory, 'tracked.txt'), 'one\n');
  await git(directory, ['add', '--', 'tracked.txt']);
  await git(directory, ['commit', '-m', 'initial']);
  return directory;
}

async function staleTrackedFile(directory: string) {
  const path = join(directory, 'tracked.txt');
  const current = await stat(path);
  await utimes(path, current.atime, new Date(current.mtimeMs + 2_000));
}

afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe('Git runner lock safety', () => {
  test('keeps an index unchanged while status reads a stale tracked file', async () => {
    const directory = await repository();
    const index = join(directory, '.git', 'index');
    await staleTrackedFile(directory);
    const before = { bytes: await readFile(index), stat: await stat(index) };
    const runner = createGitRunner();

    try {
      expect((await runner(directory, ['status', '--porcelain=v2', '-z'])).exitCode).toBe(0);
      const after = { bytes: await readFile(index), stat: await stat(index) };
      expect(after.bytes.equals(before.bytes)).toBe(true);
      expect(after.stat.mtimeMs).toBe(before.stat.mtimeMs);
    } finally {
      runner.close();
    }
  });

  test('ordinary Git status updates the stale index when optional locks are enabled', async () => {
    const directory = await repository();
    const index = join(directory, '.git', 'index');
    await staleTrackedFile(directory);
    const before = await readFile(index);
    const environment = { ...process.env };
    delete environment.GIT_OPTIONAL_LOCKS;

    expect((await git(directory, ['status', '--porcelain=v2', '-z'], environment)).exitCode).toBe(0);
    expect((await readFile(index)).equals(before)).toBe(false);
  });

  test('reads through an external index lock but leaves required writes locked', async () => {
    const directory = await repository();
    const indexLock = join(directory, '.git', 'index.lock');
    await writeFile(indexLock, 'external lock');
    await mkdir(join(directory, 'nested'));
    await writeFile(join(directory, 'nested', 'new.txt'), 'new\n');
    const runner = createGitRunner();

    try {
      expect((await runner(directory, ['status', '--porcelain=v2', '-z'])).exitCode).toBe(0);
      expect((await runner(directory, ['add', '--', 'nested/new.txt'])).exitCode).not.toBe(0);
    } finally {
      runner.close();
    }
  });
});
