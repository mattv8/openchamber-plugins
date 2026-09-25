import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitService, startGitService } from '../../src/service/index.js';
import { ServiceError } from '../../src/service/contracts.js';
import { createGitRunner } from '../../src/service/runner.js';

const directories: string[] = [];

async function git(directory: string, ...args: string[]) {
  const process = Bun.spawn(['git', ...args], { cwd: directory, stdout: 'pipe', stderr: 'pipe' });
  const code = await process.exited;
  if (code !== 0) throw new Error(await new Response(process.stderr).text());
  return new Response(process.stdout).text();
}

async function gitInput(directory: string, input: string, ...args: string[]) {
  const process = Bun.spawn(['git', ...args], { cwd: directory, stdin: new Blob([input]), stdout: 'pipe', stderr: 'pipe' });
  const code = await process.exited;
  if (code !== 0) throw new Error(await new Response(process.stderr).text());
}

async function repository() {
  const directory = await mkdtemp(join(tmpdir(), 'git-graph-service-'));
  directories.push(directory);
  await git(directory, 'init');
  await git(directory, 'config', 'user.name', 'Test User');
  await git(directory, 'config', 'user.email', 'test@example.test');
  await writeFile(join(directory, 'tracked.txt'), 'one\n');
  await git(directory, 'add', '--', 'tracked.txt');
  await git(directory, 'commit', '-m', 'initial');
  return directory;
}

async function readJob(service: ReturnType<typeof createGitService>, repositoryId: string, snapshot: string) {
  const accepted = await service.handle(new Request('http://127.0.0.1/read', { method: 'POST', headers: { authorization: 'Bearer test-token' }, body: JSON.stringify({ version: 1, requestId: 'status', operation: 'read', read: 'status', repositoryId, snapshot }) }));
  const reference = await accepted.json() as { ok: boolean; data: { jobId: string } };
  expect(reference.ok).toBe(true);
  let latest: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await service.handle(new Request('http://127.0.0.1/jobs/get', { method: 'POST', headers: { authorization: 'Bearer test-token' }, body: JSON.stringify({ version: 1, requestId: `job-${attempt}`, operation: 'jobs/get', repositoryId, jobId: reference.data.jobId }) }));
    const body = await response.json() as { data: { state: string; data: unknown } };
    latest = body;
    if (body.data.state === 'completed') return body.data.data as { read: string; status: { files: Array<{ path: string }> } };
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`read job did not complete: ${JSON.stringify(latest)}`);
}


async function readServiceJob(service: ReturnType<typeof createGitService>, repositoryId: string, request: object) {
  const accepted = await service.handle(new Request('http://127.0.0.1/read', { method: 'POST', headers: { authorization: 'Bearer test-token' }, body: JSON.stringify(request) }));
  const reference = await accepted.json() as { ok: boolean; data: { jobId: string } };
  expect(reference.ok).toBe(true);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await service.handle(new Request('http://127.0.0.1/jobs/get', { method: 'POST', headers: { authorization: 'Bearer test-token' }, body: JSON.stringify({ version: 1, requestId: `large-job-${attempt}`, operation: 'jobs/get', repositoryId, jobId: reference.data.jobId }) }));
    const body = await response.json() as { data: { state: string; data: unknown } };
    if (body.data.state === 'completed') return body.data.data;
    if (body.data.state === 'failed' || body.data.state === 'unknown') throw new Error(`read job failed: ${JSON.stringify(body)}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('read job did not complete');
}

afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe('Git loopback service', () => {
  test('opens a disposable repository and reports its authoritative status over HTTP', async () => {
    const directory = await repository();
    await writeFile(join(directory, 'new file.txt'), 'new\n');
    const service = createGitService({ token: 'test-token' });
    const opened = await service.handle(new Request('http://127.0.0.1/repo/open', { method: 'POST', headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, requestId: 'open', operation: 'repo/open', repositoryId: 'ignored', directory }) }));
    const repositoryData = await opened.json() as { ok: boolean; data: { id: string; snapshot: string } };
    expect(repositoryData.ok).toBe(true);
    const statusData = await readJob(service, repositoryData.data.id, repositoryData.data.snapshot);
    expect(statusData.status.files.map((file) => file.path)).toContain('new file.txt');
  });

  test('gives concurrent opens the same usable snapshot', async () => {
    const directory = await repository();
    await writeFile(join(directory, 'new file.txt'), 'new\n');
    const service = createGitService({ token: 'test-token' });
    try {
      for (let round = 0; round < 5; round += 1) {
        const open = (index: number) => service.handle(new Request('http://127.0.0.1/repo/open', {
          method: 'POST',
          headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
          body: JSON.stringify({ version: 1, requestId: `parallel-${round}-${index}`, operation: 'repo/open', repositoryId: 'ignored', directory }),
        }));
        const opened = await Promise.all([0, 1, 2].map(open));
        const responses = await Promise.all(opened.map((response) => response.json() as Promise<{ ok: boolean; data?: { id: string; snapshot: string } }>));
        expect(responses.every((response) => response.ok)).toBe(true);
        const repositories = responses.flatMap((response) => response.data ? [response.data] : []);
        expect(repositories).toHaveLength(3);
        expect(repositories[0]!.snapshot).not.toBe('');
        expect(new Set(repositories.map((repositoryData) => repositoryData.snapshot)).size).toBe(1);
        const status = await readJob(service, repositories[0]!.id, repositories[0]!.snapshot);
        expect(status.status.files.map((file) => file.path)).toContain('new file.txt');
      }
    } finally {
      service.close();
    }
  });

  test('rejects an unauthenticated mutation without invoking Git', async () => {
    const service = createGitService({ token: 'test-token' });
    const response = await service.handle(new Request('http://127.0.0.1/mutate', { method: 'POST', body: '{}' }));
    expect(response.status).toBe(401);
  });

  test('requires the bearer token for health checks', async () => {
    const service = createGitService({ token: 'test-token' });
    expect((await service.handle(new Request('http://127.0.0.1/health'))).status).toBe(401);
  });

  test('changes the snapshot when a modified file changes again', async () => {
    const directory = await repository();
    await writeFile(join(directory, 'tracked.txt'), 'first edit\n');
    const service = createGitService({ token: 'test-token' });
    const open = await service.handle(new Request('http://127.0.0.1/repo/open', { method: 'POST', headers: { authorization: 'Bearer test-token' }, body: JSON.stringify({ version: 1, requestId: 'open', operation: 'repo/open', repositoryId: 'ignored', directory }) }));
    const data = await open.json() as { data: { id: string; snapshot: string } };
    await writeFile(join(directory, 'tracked.txt'), 'second edit\n');
    const refresh = await service.handle(new Request('http://127.0.0.1/refresh', { method: 'POST', headers: { authorization: 'Bearer test-token' }, body: JSON.stringify({ version: 1, requestId: 'refresh', operation: 'refresh', repositoryId: data.data.id, snapshot: data.data.snapshot }) }));
    expect((await refresh.json() as { data: { changed: boolean } }).data.changed).toBe(true);
  });

  test('accepts an HTTP mutation and retains its terminal job result', async () => {
    const directory = await repository();
    await writeFile(join(directory, 'new.txt'), 'new\n');
    const running = await startGitService({ token: 'test-token' });
    try {
      const post = (route: string, body: object) => fetch(`http://127.0.0.1:${running.port}${route}`, { method: 'POST', headers: { authorization: 'Bearer test-token' }, body: JSON.stringify(body) });
      const opened = await post('/repo/open', { version: 1, requestId: 'open-http', operation: 'repo/open', repositoryId: 'ignored', directory });
      const repositoryData = await opened.json() as { data: { id: string; snapshot: string } };
      const accepted = await post('/mutate', { version: 1, requestId: 'mutate-http', operation: 'mutate', repositoryId: repositoryData.data.id, snapshot: repositoryData.data.snapshot, expectedSnapshot: repositoryData.data.snapshot, operationId: 'stage-new', action: { mutation: 'stage-path', path: 'new.txt' } });
      const reference = await accepted.json() as { data: { jobId: string } };
      let terminal: { state: string; data: { operationId: string } | null } | undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const response = await post('/jobs/get', { version: 1, requestId: `poll-${attempt}`, operation: 'jobs/get', repositoryId: repositoryData.data.id, jobId: reference.data.jobId });
        terminal = (await response.json() as { data: typeof terminal }).data;
        if (terminal?.state === 'completed') break;
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      expect(terminal?.state).toBe('completed');
      expect(terminal?.data?.operationId).toBe('stage-new');
    } finally { await running.close(); }
  });

  test('opens a 300KB dirty tree and invalidates a snapshot when untracked content changes', async () => {
    const directory = await repository();
    await writeFile(join(directory, 'large.txt'), 'a'.repeat(300_000));
    const service = createGitService({ token: 'test-token' });
    const opened = await service.handle(new Request('http://127.0.0.1/repo/open', { method: 'POST', headers: { authorization: 'Bearer test-token' }, body: JSON.stringify({ version: 1, requestId: 'open-large', operation: 'repo/open', repositoryId: 'ignored', directory }) }));
    const data = await opened.json() as { ok: boolean; data: { id: string; snapshot: string } };
    expect(data.ok).toBe(true);
    await writeFile(join(directory, 'large.txt'), 'b'.repeat(300_000));
    const refreshed = await service.handle(new Request('http://127.0.0.1/refresh', { method: 'POST', headers: { authorization: 'Bearer test-token' }, body: JSON.stringify({ version: 1, requestId: 'refresh-large', operation: 'refresh', repositoryId: data.data.id, snapshot: data.data.snapshot }) }));
    const changed = await refreshed.json() as { data: { snapshot: string; changed: boolean } };
    expect(changed.data.changed).toBe(true);
    const stale = await service.handle(new Request('http://127.0.0.1/read', { method: 'POST', headers: { authorization: 'Bearer test-token' }, body: JSON.stringify({ version: 1, requestId: 'stale-large', operation: 'read', read: 'status', repositoryId: data.data.id, snapshot: data.data.snapshot }) }));
    expect(stale.status).toBe(409);
  });

  test('opens and reads history from a repository whose index listing exceeds the default Git output limit', async () => {
    const directory = await repository();
    const indexedDirectory = join(directory, 'indexed');
    await mkdir(indexedDirectory);
    for (let start = 0; start < 1_800; start += 200) {
      await Promise.all(Array.from({ length: Math.min(200, 1_800 - start) }, (_, offset) => {
        const index = start + offset;
        return writeFile(join(indexedDirectory, `${index.toString().padStart(4, '0')}-${'x'.repeat(80)}.txt`), 'indexed\n');
      }));
    }
    await git(directory, 'add', '--', 'indexed');
    await git(directory, 'commit', '-m', 'large index');
    const indexListing = await git(directory, 'ls-files', '--stage', '-z');
    expect(Buffer.byteLength(indexListing)).toBeGreaterThan(240_000);

    const service = createGitService({ token: 'test-token' });
    try {
      const opened = await service.handle(new Request('http://127.0.0.1/repo/open', { method: 'POST', headers: { authorization: 'Bearer test-token' }, body: JSON.stringify({ version: 1, requestId: 'open-large-index', operation: 'repo/open', repositoryId: 'ignored', directory }) }));
      const repositoryData = await opened.json() as { ok: boolean; data: { id: string; snapshot: string } };
      expect(repositoryData.ok).toBe(true);

      const refs = await readServiceJob(service, repositoryData.data.id, { version: 1, requestId: 'large-index-refs', operation: 'read', read: 'refs', repositoryId: repositoryData.data.id, snapshot: repositoryData.data.snapshot }) as { read: string; current: { id: string } | null };
      expect(refs.read).toBe('refs');
      expect(refs.current).not.toBeNull();

      const history = await readServiceJob(service, repositoryData.data.id, { version: 1, requestId: 'large-index-history', operation: 'read', read: 'history', repositoryId: repositoryData.data.id, snapshot: repositoryData.data.snapshot, refs: ['HEAD'], cursor: null, limit: 12 }) as { read: string; items: Array<{ subject: string }> };
      expect(history.read).toBe('history');
      expect(history.items[0]?.subject).toBe('large index');
    } finally { service.close(); }
  });

  test('reads refs and history when internal ref metadata exceeds the default Git output limit', async () => {
    const directory = await repository();
    const head = (await git(directory, 'rev-parse', 'HEAD')).trim();
    const updates = Array.from({ length: 700 }, (_, index) => `update refs/remotes/load-${index.toString().padStart(4, '0')}-${'r'.repeat(150)}/HEAD ${head}`).join('\n');
    await gitInput(directory, `${updates}\n`, 'update-ref', '--stdin');
    const metadata = await git(directory, 'for-each-ref', '--format=%(refname)%00%(refname:short)%00%(objectname)%00%(*objectname)%00%(HEAD)%00%(upstream:short)', 'refs/heads', 'refs/remotes', 'refs/tags');
    expect(Buffer.byteLength(metadata)).toBeGreaterThan(240_000);

    const service = createGitService({ token: 'test-token' });
    try {
      const opened = await service.handle(new Request('http://127.0.0.1/repo/open', { method: 'POST', headers: { authorization: 'Bearer test-token' }, body: JSON.stringify({ version: 1, requestId: 'open-many-refs', operation: 'repo/open', repositoryId: 'ignored', directory }) }));
      const repositoryData = await opened.json() as { ok: boolean; data: { id: string; snapshot: string } };
      expect(repositoryData.ok).toBe(true);

      const refs = await readServiceJob(service, repositoryData.data.id, { version: 1, requestId: 'many-refs', operation: 'read', read: 'refs', repositoryId: repositoryData.data.id, snapshot: repositoryData.data.snapshot }) as { read: string; refs: Array<{ id: string }>; current: { id: string } | null };
      expect(refs.read).toBe('refs');
      expect(refs.current).not.toBeNull();
      expect(refs.refs.some((ref) => ref.id.endsWith('/HEAD'))).toBe(false);

      const history = await readServiceJob(service, repositoryData.data.id, { version: 1, requestId: 'many-refs-history', operation: 'read', read: 'history', repositoryId: repositoryData.data.id, snapshot: repositoryData.data.snapshot, refs: ['HEAD'], cursor: null, limit: 12 }) as { read: string; items: Array<{ subject: string }> };
      expect(history.read).toBe('history');
      expect(history.items[0]?.subject).toBe('initial');
    } finally { service.close(); }
  });

  test('keeps the default Git command output limit for non-snapshot commands', async () => {
    const directory = await repository();
    await writeFile(join(directory, 'large.txt'), 'a'.repeat(300_000));
    await git(directory, 'add', '--', 'large.txt');
    await git(directory, 'commit', '-m', 'large blob');
    const runner = createGitRunner();
    try {
      const failure = await runner(directory, ['show', 'HEAD:large.txt']).catch((error) => error);
      expect(failure).toBeInstanceOf(ServiceError);
      if (!(failure instanceof ServiceError)) throw new Error('expected Git output limit error');
      expect(failure.code).toBe('unsupported');
      expect(failure.message).toMatch(/^Git show output exceeded 240000-byte limit after observing \d+ bytes$/);
      expect(Number(/observing (\d+) bytes/.exec(failure.message)?.[1])).toBeGreaterThan(240_000);
      expect(failure.message).not.toContain('HEAD:large.txt');
    } finally { runner.close(); }
  });

  test('does not fingerprint ignored large files', async () => {
    const directory = await repository();
    await writeFile(join(directory, '.gitignore'), 'ignored/\n'); await git(directory, 'add', '--', '.gitignore'); await git(directory, 'commit', '-m', 'ignore generated files');
    await mkdir(join(directory, 'ignored'));
    await Bun.write(join(directory, 'ignored', 'large.bin'), 'a'.repeat(300_000));
    const service = createGitService({ token: 'test-token' });
    const opened = await service.handle(new Request('http://127.0.0.1/repo/open', { method: 'POST', headers: { authorization: 'Bearer test-token' }, body: JSON.stringify({ version: 1, requestId: 'open-ignored', operation: 'repo/open', repositoryId: 'ignored', directory }) }));
    const data = await opened.json() as { data: { id: string; snapshot: string } };
    await Bun.write(join(directory, 'ignored', 'large.bin'), 'b'.repeat(300_000));
    const refreshed = await service.handle(new Request('http://127.0.0.1/refresh', { method: 'POST', headers: { authorization: 'Bearer test-token' }, body: JSON.stringify({ version: 1, requestId: 'refresh-ignored', operation: 'refresh', repositoryId: data.data.id, snapshot: data.data.snapshot }) }));
    expect((await refreshed.json() as { data: { changed: boolean } }).data.changed).toBe(false);
  });
});
