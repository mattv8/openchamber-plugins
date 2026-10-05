import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { createCommitAuthorLookup, createGhExecutor } from '../../src/service/github-author.js';
import type { Repository } from '../../src/service/contracts.js';

const repository = { id: 'repo', root: '/repo', commonGitDir: '/repo/.git', gitDir: '/repo/.git', snapshot: 'snapshot' } satisfies Repository;
const sha = 'a'.repeat(40);
const rawAuthor = { login: 'octocat', avatar_url: 'https://avatars.githubusercontent.com/u/583231?v=4', id: 583231, type: 'User', html_url: 'https://github.com/octocat' };
const author = { login: rawAuthor.login, avatarUrl: rawAuthor.avatar_url };
const origin = [{ name: 'origin', fetchUrl: 'https://github.com/openchamber/plugins.git', pushUrl: null }];
const result = (exitCode: number, body = '', stderr = '', unavailable = false) => ({ exitCode, stdout: Buffer.from(body), stderr: Buffer.from(stderr), unavailable });
const response = (raw: unknown) => new Response(JSON.stringify({ author: raw }));

describe('commit author lookup', () => {
  test('maps realistic authenticated gh data without a public request', async () => {
    let fetched = 0;
    const lookup = createCommitAuthorLookup({ readRemotes: async () => origin, execGh: async (args) => { expect(args).toEqual(['api', '--hostname', 'github.com', `repos/openchamber/plugins/commits/${sha}`]); return result(0, JSON.stringify({ author: rawAuthor, sha, url: 'https://api.github.com/commits/test' })); }, fetch: async () => { fetched += 1; throw new Error('must not fetch'); } });
    expect(await lookup.read(repository, sha)).toEqual(author); expect(fetched).toBe(0);
  });

  test.each(['not logged into any GitHub hosts', 'To get started with GitHub CLI, please run: gh auth login'])('uses the public API only for unavailable gh: %s', async (stderr) => {
    let url = '';
    const lookup = createCommitAuthorLookup({ readRemotes: async () => origin, execGh: async () => result(4, '', stderr), fetch: async (input) => { url = input; return response(rawAuthor); } });
    expect(await lookup.read(repository, sha)).toEqual(author); expect(url).toBe(`https://api.github.com/repos/openchamber/plugins/commits/${sha}`);
  });

  test('falls back when gh is absent but not for transient, 404, or rate-limit failures', async () => {
    let fetched = 0;
    const absent = createCommitAuthorLookup({ readRemotes: async () => origin, execGh: async () => result(1, '', '', true), fetch: async () => { fetched += 1; return response(rawAuthor); } });
    expect(await absent.read(repository, sha)).toEqual(author);
    for (const gh of [result(1, '', 'network unavailable'), result(1, '', 'HTTP 404 Not Found'), result(1, '', 'API rate limit exceeded')]) {
      const lookup = createCommitAuthorLookup({ readRemotes: async () => origin, execGh: async () => gh, fetch: async () => { fetched += 1; return response(rawAuthor); } });
      expect(await lookup.read(repository, sha)).toBeNull();
    }
    expect(fetched).toBe(1);
  });

  test('normalizes bot accounts and rejects invalid login, avatar, and non-GitHub remotes', async () => {
    const bot = createCommitAuthorLookup({ readRemotes: async () => origin, execGh: async () => result(0, JSON.stringify({ author: { ...rawAuthor, login: 'dependabot[bot]', type: 'Bot' } })) });
    expect(await bot.read(repository, sha)).toEqual({ ...author, login: 'dependabot[bot]' });
    for (const raw of [{ ...rawAuthor, login: 'octocat!' }, { ...rawAuthor, avatar_url: 'https://avatars.githubusercontent.com.evil/u/1' }]) {
      const lookup = createCommitAuthorLookup({ readRemotes: async () => origin, execGh: async () => result(0, JSON.stringify({ author: raw })) });
      expect(await lookup.read(repository, sha)).toBeNull();
    }
    const other = createCommitAuthorLookup({ readRemotes: async () => [{ name: 'origin', fetchUrl: 'https://example.test/openchamber/plugins.git', pushUrl: null }], execGh: async () => { throw new Error('should not run'); } });
    expect(await other.read(repository, sha)).toBeNull();
  });

  test('bounds streamed public bodies and cancels public lookup on timeout or close', async () => {
    const huge = createCommitAuthorLookup({ readRemotes: async () => origin, execGh: async () => result(1, '', '', true), fetch: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(256_001)); controller.close(); } })) });
    expect(await huge.read(repository, sha)).toBeNull();
    let timedOut = false;
    const timeout = createCommitAuthorLookup({ readRemotes: async () => origin, execGh: async () => result(1, '', '', true), timeoutMs: 10, fetch: async (_input, init) => new Promise((resolve) => init.signal?.addEventListener('abort', () => { timedOut = true; resolve(response(rawAuthor)); }, { once: true })) });
    expect(await timeout.read(repository, sha)).toBeNull(); expect(timedOut).toBe(true);
    let started: (() => void) | undefined;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const close = createCommitAuthorLookup({ readRemotes: async () => origin, execGh: async () => result(1, '', '', true), fetch: async (_input, init) => new Promise((resolve) => { started!(); init.signal?.addEventListener('abort', () => resolve(response(rawAuthor)), { once: true }); }) });
    const pending = close.read(repository, sha); await running; close.close(); expect(await pending).toBeNull();
  });

  test('caches null briefly, deduplicates requests, and isolates remotes', async () => {
    let time = 0; let calls = 0; let release: (() => void) | undefined;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const lookup = createCommitAuthorLookup({ readRemotes: async (current) => current.root === '/other' ? [{ name: 'origin', fetchUrl: 'git@github.com:other/repo.git', pushUrl: null }] : origin, now: () => time, execGh: async () => { calls += 1; await wait; return result(0, JSON.stringify({ author: null })); } });
    const first = lookup.read(repository, sha); const second = lookup.read(repository, sha); release!();
    expect(await Promise.all([first, second])).toEqual([null, null]); expect(calls).toBe(1);
    expect(await lookup.read(repository, sha)).toBeNull(); expect(calls).toBe(1);
    time = 60_001; expect(await lookup.read(repository, sha)).toBeNull(); expect(calls).toBe(2);
    expect(await lookup.read({ ...repository, root: '/other' }, sha)).toBeNull(); expect(calls).toBe(3);
  });
});

describe('gh executor', () => {
  const nodeChild = ((_: string, _args: readonly string[], options: Parameters<typeof spawn>[2]) => spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000)'], options)) as typeof spawn;
  test('terminates real children on timeout and close', async () => {
    const timeout = createGhExecutor(20, nodeChild); const timed = await timeout(['api'], new AbortController().signal); expect(timed.exitCode).toBe(1); timeout.close();
    const executor = createGhExecutor(1_000, nodeChild); const pending = executor(['api'], new AbortController().signal); executor.close(); expect((await pending).exitCode).toBe(1);
  });
});
