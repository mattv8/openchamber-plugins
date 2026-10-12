import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { createCommitAuthorLookup, createGhExecutor } from '../../src/service/github-author.js';
import type { Repository } from '../../src/service/contracts.js';

const repository = { id: 'repo', root: '/repo', commonGitDir: '/repo/.git', gitDir: '/repo/.git', snapshot: 'snapshot' } satisfies Repository;
const sha = 'a'.repeat(40);
const rawAuthor = { login: 'octocat', avatar_url: 'https://avatars.githubusercontent.com/u/583231?v=4', id: 583231, type: 'User', html_url: 'https://github.com/octocat' };
const author = { login: rawAuthor.login, avatarUrl: rawAuthor.avatar_url };
const linked = { resolution: 'linked' as const, author };
const unlinked = { resolution: 'unlinked' as const, author: null };
const unavailable = { resolution: 'unavailable' as const, author: null };
const origin = [{ name: 'origin', fetchUrl: 'https://github.com/openchamber/plugins.git', pushUrl: null }];
const result = (exitCode: number, body = '', stderr = '', unavailable = false) => ({ exitCode, stdout: Buffer.from(body), stderr: Buffer.from(stderr), unavailable });
const response = (raw: unknown) => new Response(JSON.stringify({ author: raw }));

function expectResolvedLookup(value: unknown, expected: typeof linked | typeof unlinked) {
  expect(value).toMatchObject(expected);
  expect(value).toHaveProperty('fetchedAt', expect.any(Number));
}

describe('commit author lookup', () => {
  test('maps realistic authenticated gh data without a public request', async () => {
    let fetched = 0;
    const lookup = createCommitAuthorLookup({ readRemotes: async () => origin, execGh: async (args) => { expect(args).toEqual(['api', '--hostname', 'github.com', `repos/openchamber/plugins/commits/${sha}`]); return result(0, JSON.stringify({ author: rawAuthor, sha, url: 'https://api.github.com/commits/test' })); }, fetch: async () => { fetched += 1; throw new Error('must not fetch'); } });
    expectResolvedLookup(await lookup.read(repository, sha), linked); expect(fetched).toBe(0);
  });

  test.each(['not logged into any GitHub hosts', 'To get started with GitHub CLI, please run: gh auth login'])('uses the public API only for unavailable gh: %s', async (stderr) => {
    let url = '';
    const lookup = createCommitAuthorLookup({ readRemotes: async () => origin, execGh: async () => result(4, '', stderr), fetch: async (input) => { url = input; return response(rawAuthor); } });
    expectResolvedLookup(await lookup.read(repository, sha), linked); expect(url).toBe(`https://api.github.com/repos/openchamber/plugins/commits/${sha}`);
  });

  test('falls back when gh is absent but not for transient, 404, or rate-limit failures', async () => {
    let fetched = 0;
    const absent = createCommitAuthorLookup({ readRemotes: async () => origin, execGh: async () => result(1, '', '', true), fetch: async () => { fetched += 1; return response(rawAuthor); } });
    expectResolvedLookup(await absent.read(repository, sha), linked);
    for (const gh of [result(1, '', 'network unavailable'), result(1, '', 'HTTP 404 Not Found'), result(1, '', 'API rate limit exceeded')]) {
      const lookup = createCommitAuthorLookup({ readRemotes: async () => origin, execGh: async () => gh, fetch: async () => { fetched += 1; return response(rawAuthor); } });
      expect(await lookup.read(repository, sha)).toEqual(unavailable);
    }
    expect(fetched).toBe(1);
  });

  test('classifies public fallback null authors as unlinked and malformed or rejected responses as unavailable', async () => {
    const unavailableGh = async () => result(1, '', '', true);
    const cases: Array<{ response: Response; expected: typeof unlinked | typeof unavailable }> = [
      { response: response(null), expected: unlinked },
      { response: new Response('{}'), expected: unavailable },
      { response: new Response('', { status: 404 }), expected: unavailable },
      { response: new Response('', { status: 403 }), expected: unavailable },
    ];
    for (const entry of cases) {
      const lookup = createCommitAuthorLookup({ readRemotes: async () => origin, execGh: unavailableGh, fetch: async () => entry.response });
      if (entry.expected.resolution === 'unlinked') expectResolvedLookup(await lookup.read(repository, sha), entry.expected);
      else expect(await lookup.read(repository, sha)).toEqual(entry.expected);
    }
  });

  test('classifies successful gh responses without an author as unavailable', async () => {
    const lookup = createCommitAuthorLookup({ readRemotes: async () => origin, execGh: async () => result(0, '{}') });
    expect(await lookup.read(repository, sha)).toEqual(unavailable);
  });

  test('retains public linked and unlinked lookups for 24 hours before refetching', async () => {
    let time = 0;
    let calls = 0;
    const publicAuthors = [rawAuthor, null, null];
    const lookup = createCommitAuthorLookup({
      readRemotes: async () => origin,
      now: () => time,
      execGh: async () => result(1, '', '', true),
      fetch: async () => response(publicAuthors[calls++]!),
    });

    const linkedResult = await lookup.read(repository, sha);
    expectResolvedLookup(linkedResult, linked);
    expect(linkedResult).toMatchObject({ fetchedAt: 0 });
    time = 24 * 60 * 60_000 - 1;
    const cachedLinked = await lookup.read(repository, sha);
    expectResolvedLookup(cachedLinked, linked);
    expect(cachedLinked).toMatchObject({ fetchedAt: 0 });
    expect(calls).toBe(1);
    time += 1;
    const unlinkedResult = await lookup.read(repository, sha);
    expectResolvedLookup(unlinkedResult, unlinked);
    expect(unlinkedResult).toMatchObject({ fetchedAt: 24 * 60 * 60_000 });
    expect(calls).toBe(2);
    time += 24 * 60 * 60_000 - 1;
    const cachedUnlinked = await lookup.read(repository, sha);
    expectResolvedLookup(cachedUnlinked, unlinked);
    expect(cachedUnlinked).toMatchObject({ fetchedAt: 24 * 60 * 60_000 });
    expect(calls).toBe(2);
    time += 1;
    const refreshedUnlinked = await lookup.read(repository, sha);
    expectResolvedLookup(refreshedUnlinked, unlinked);
    expect(refreshedUnlinked).toMatchObject({ fetchedAt: 48 * 60 * 60_000 });
    expect(calls).toBe(3);
  });

  test('normalizes bot accounts and rejects invalid login, avatar, and non-GitHub remotes', async () => {
    const bot = createCommitAuthorLookup({ readRemotes: async () => origin, execGh: async () => result(0, JSON.stringify({ author: { ...rawAuthor, login: 'dependabot[bot]', type: 'Bot' } })) });
    expectResolvedLookup(await bot.read(repository, sha), { resolution: 'linked', author: { ...author, login: 'dependabot[bot]' } });
    for (const raw of [{ ...rawAuthor, login: 'octocat!' }, { ...rawAuthor, avatar_url: 'https://avatars.githubusercontent.com.evil/u/1' }]) {
      const lookup = createCommitAuthorLookup({ readRemotes: async () => origin, execGh: async () => result(0, JSON.stringify({ author: raw })) });
      expect(await lookup.read(repository, sha)).toEqual(unavailable);
    }
    const other = createCommitAuthorLookup({ readRemotes: async () => [{ name: 'origin', fetchUrl: 'https://example.test/openchamber/plugins.git', pushUrl: null }], execGh: async () => { throw new Error('should not run'); } });
    expect(await other.read(repository, sha)).toEqual(unavailable);
  });

  test('bounds streamed public bodies and cancels public lookup on timeout or close', async () => {
    const huge = createCommitAuthorLookup({ readRemotes: async () => origin, execGh: async () => result(1, '', '', true), fetch: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(256_001)); controller.close(); } })) });
    expect(await huge.read(repository, sha)).toEqual(unavailable);
    let timedOut = false;
    const timeout = createCommitAuthorLookup({ readRemotes: async () => origin, execGh: async () => result(1, '', '', true), timeoutMs: 10, fetch: async (_input, init) => new Promise((resolve) => init.signal?.addEventListener('abort', () => { timedOut = true; resolve(response(rawAuthor)); }, { once: true })) });
    expect(await timeout.read(repository, sha)).toEqual(unavailable); expect(timedOut).toBe(true);
    let started: (() => void) | undefined;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const close = createCommitAuthorLookup({ readRemotes: async () => origin, execGh: async () => result(1, '', '', true), fetch: async (_input, init) => new Promise((resolve) => { started!(); init.signal?.addEventListener('abort', () => resolve(response(rawAuthor)), { once: true }); }) });
    const pending = close.read(repository, sha); await running; close.close(); expect(await pending).toEqual(unavailable);
  });

  test('caches unlinked authors for 24 hours, unavailable results for one minute, deduplicates requests, and isolates remotes', async () => {
    let time = 0; let calls = 0; let release: (() => void) | undefined;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const lookup = createCommitAuthorLookup({ readRemotes: async (current) => current.root === '/other' ? [{ name: 'origin', fetchUrl: 'git@github.com:other/repo.git', pushUrl: null }] : origin, now: () => time, execGh: async () => { calls += 1; await wait; return result(0, JSON.stringify({ author: null })); } });
    const first = lookup.read(repository, sha); const second = lookup.read(repository, sha); release!();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expectResolvedLookup(firstResult, unlinked); expectResolvedLookup(secondResult, unlinked); expect(firstResult).toMatchObject({ fetchedAt: 0 }); expect(secondResult).toMatchObject({ fetchedAt: 0 }); expect(calls).toBe(1);
    time = 24 * 60 * 60_000 - 1; const cached = await lookup.read(repository, sha); expectResolvedLookup(cached, unlinked); expect(cached).toMatchObject({ fetchedAt: 0 }); expect(calls).toBe(1);
    time += 1; const refreshed = await lookup.read(repository, sha); expectResolvedLookup(refreshed, unlinked); expect(refreshed).toMatchObject({ fetchedAt: 24 * 60 * 60_000 }); expect(calls).toBe(2);
    expectResolvedLookup(await lookup.read({ ...repository, root: '/other' }, sha), unlinked); expect(calls).toBe(3);
  });

  test('retries unavailable lookups after one minute', async () => {
    let time = 0;
    let calls = 0;
    const lookup = createCommitAuthorLookup({ readRemotes: async () => origin, now: () => time, execGh: async () => { calls += 1; throw new Error('network failure'); } });
    expect(await lookup.read(repository, sha)).toEqual(unavailable);
    time = 59_999;
    expect(await lookup.read(repository, sha)).toEqual(unavailable);
    expect(calls).toBe(1);
    time = 60_000;
    expect(await lookup.read(repository, sha)).toEqual(unavailable);
    expect(calls).toBe(2);
  });
});

describe('gh executor', () => {
  const nodeChild = ((_: string, _args: readonly string[], options: Parameters<typeof spawn>[2]) => spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000)'], options)) as typeof spawn;
  test('terminates real children on timeout and close', async () => {
    const timeout = createGhExecutor(20, nodeChild); const timed = await timeout(['api'], new AbortController().signal); expect(timed.exitCode).toBe(1); timeout.close();
    const executor = createGhExecutor(1_000, nodeChild); const pending = executor(['api'], new AbortController().signal); executor.close(); expect((await pending).exitCode).toBe(1);
  });
});
