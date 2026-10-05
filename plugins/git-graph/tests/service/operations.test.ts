import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitService } from '../../src/service/index.js';

const directories: string[] = [];

async function git(directory: string, ...args: string[]) {
  const process = Bun.spawn(['git', ...args], { cwd: directory, stdout: 'pipe', stderr: 'pipe' });
  if (await process.exited !== 0) throw new Error(await new Response(process.stderr).text());
  return new Response(process.stdout).text();
}

async function repository() {
  const directory = await mkdtemp(join(tmpdir(), 'git-graph-operations-'));
  directories.push(directory);
  await git(directory, 'init');
  await git(directory, 'config', 'user.name', 'Test User');
  await git(directory, 'config', 'user.email', 'test@example.test');
  await writeFile(join(directory, 'tracked.txt'), 'initial\n');
  await git(directory, 'add', '--', 'tracked.txt');
  await git(directory, 'commit', '-m', 'initial');
  return directory;
}

const request = (path: string, body: object) => new Request(`http://127.0.0.1${path}`, {
  method: 'POST', headers: { authorization: 'Bearer test-token' }, body: JSON.stringify(body),
});

async function open(service: ReturnType<typeof createGitService>, directory: string) {
  return (await service.handle(request('/repo/open', { version: 1, requestId: 'open', operation: 'repo/open', repositoryId: 'ignored', directory }))).json() as Promise<{ data: { id: string; snapshot: string } }>;
}

async function operation(service: ReturnType<typeof createGitService>, repositoryId: string, operationId: string) {
  return (await service.handle(request('/operations/get', { version: 1, requestId: `operation-${operationId}`, operation: 'operations/get', repositoryId, operationId }))).json() as Promise<{ ok: boolean; data: { state: string; jobId: string | null; snapshot: string | null; error: { code: string } | null } }>;
}

async function terminalOperation(service: ReturnType<typeof createGitService>, repositoryId: string, operationId: string) {
  let status = await operation(service, repositoryId, operationId);
  for (let attempt = 0; status.data.state === 'running' && attempt < 100; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    status = await operation(service, repositoryId, operationId);
  }
  return status;
}

afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe('operation recovery status', () => {
  test('reports absent without reserving or executing an operation', async () => {
    const directory = await repository();
    const service = createGitService({ token: 'test-token' });
    const opened = await open(service, directory);

    expect(await operation(service, opened.data.id, 'never-submitted')).toMatchObject({ ok: true, data: { state: 'absent', jobId: null, snapshot: null, error: null } });
    expect(await git(directory, 'status', '--porcelain')).toBe('');
  });

  test('reports completed and failed journal records after the job is no longer in memory', async () => {
    const directory = await repository();
    const service = createGitService({ token: 'test-token' });
    const opened = await open(service, directory);
    const journal = {
      [`${opened.data.id}:done`]: { repositoryId: opened.data.id, identity: 'done', jobId: 'done-job', createdAt: 2, state: 'completed', snapshot: opened.data.snapshot },
      [`${opened.data.id}:failed`]: { repositoryId: opened.data.id, identity: 'failed', jobId: 'failed-job', createdAt: 1, state: 'failed', snapshot: null },
      [`${opened.data.id}:pending`]: { repositoryId: opened.data.id, identity: 'pending', jobId: 'pending-job', createdAt: 0, state: 'pending', snapshot: null },
    };
    await writeFile(join(directory, '.git', 'openchamber-git-graph-operations.json'), JSON.stringify(journal));

    expect((await operation(service, opened.data.id, 'done')).data).toMatchObject({ state: 'completed', jobId: null, snapshot: opened.data.snapshot, error: null });
    expect((await operation(service, opened.data.id, 'failed')).data).toMatchObject({ state: 'failed', jobId: null, snapshot: null });
    expect((await operation(service, opened.data.id, 'pending')).data).toMatchObject({ state: 'unknown', jobId: null, snapshot: null });
  });

  test('replays a journaled failure as its original terminal error', async () => {
    const directory = await repository();
    const service = createGitService({ token: 'test-token' });
    const opened = await open(service, directory);
    const action = { mutation: 'stage-path' as const, path: 'missing.txt' };
    const identity = createHash('sha256').update(JSON.stringify({ expectedSnapshot: opened.data.snapshot, action })).digest('hex');
    await writeFile(join(directory, '.git', 'openchamber-git-graph-operations.json'), JSON.stringify({
      [`${opened.data.id}:failed-replay`]: { repositoryId: opened.data.id, identity, jobId: 'failed-job', createdAt: 1, state: 'failed', snapshot: null, error: { code: 'not-found', message: 'Requested Git object was not found', retryable: false } },
    }));
    service.close();
    const restarted = createGitService({ token: 'test-token' });
    const reopened = await open(restarted, directory);

    const response = await restarted.handle(request('/mutate', { version: 1, requestId: 'failed-replay', operation: 'mutate', repositoryId: reopened.data.id, snapshot: reopened.data.snapshot, expectedSnapshot: opened.data.snapshot, operationId: 'failed-replay', action }));
    expect(response.status).toBe(404);
    expect((await response.json() as { error: { code: string } }).error.code).toBe('not-found');
  });

  test('marks a pre-Git snapshot conflict failed for recovery', async () => {
    const directory = await repository();
    await writeFile(join(directory, 'new.txt'), 'new\n');
    const service = createGitService({ token: 'test-token' });
    const opened = await open(service, directory);
    const accepted = await service.handle(request('/mutate', { version: 1, requestId: 'mutate', operation: 'mutate', repositoryId: opened.data.id, snapshot: opened.data.snapshot, expectedSnapshot: 'stale-snapshot', operationId: 'stale-write', action: { mutation: 'stage-path', path: 'new.txt' } }));
    expect(accepted.status).toBe(200);

    const status = await terminalOperation(service, opened.data.id, 'stale-write');
    expect(status.data).toMatchObject({ state: 'failed', jobId: expect.any(String), error: { code: 'snapshot-conflict' } });
    expect(await git(directory, 'diff', '--cached', '--name-only')).toBe('');
  });

  test('refuses a new reservation when journal retention would evict pending operations', async () => {
    const directory = await repository();
    await writeFile(join(directory, 'new.txt'), 'new\n');
    const service = createGitService({ token: 'test-token' });
    const opened = await open(service, directory);
    const journal = Object.fromEntries(Array.from({ length: 256 }, (_, index) => [`${opened.data.id}:pending-${index}`, { repositoryId: opened.data.id, identity: `pending-${index}`, jobId: `job-${index}`, createdAt: index, state: 'pending', snapshot: null }]));
    await writeFile(join(directory, '.git', 'openchamber-git-graph-operations.json'), JSON.stringify(journal));

    const response = await service.handle(request('/mutate', { version: 1, requestId: 'full', operation: 'mutate', repositoryId: opened.data.id, snapshot: opened.data.snapshot, expectedSnapshot: opened.data.snapshot, operationId: 'new-write', action: { mutation: 'stage-path', path: 'new.txt' } }));
    expect(response.status).toBe(409);
    expect((await response.json() as { error: { code: string } }).error.code).toBe('repository-busy');
    expect(await git(directory, 'diff', '--cached', '--name-only')).toBe('');
  });

  test('does not retain failed validation operations as pending', async () => {
    const directory = await repository();
    await writeFile(join(directory, 'new.txt'), 'new\n');
    const service = createGitService({ token: 'test-token' });
    const opened = await open(service, directory);
    const head = (await git(directory, 'rev-parse', 'HEAD')).trim();

    for (let index = 0; index < 257; index += 1) {
      await service.handle(request('/mutate', { version: 1, requestId: `invalid-${index}`, operation: 'mutate', repositoryId: opened.data.id, snapshot: opened.data.snapshot, expectedSnapshot: opened.data.snapshot, operationId: `invalid-${index}`, action: { mutation: 'reset', commit: head, mode: 'hard', force: false } }));
      expect((await terminalOperation(service, opened.data.id, `invalid-${index}`)).data.state).toBe('failed');
    }

    const accepted = await service.handle(request('/mutate', { version: 1, requestId: 'valid-after-failures', operation: 'mutate', repositoryId: opened.data.id, snapshot: opened.data.snapshot, expectedSnapshot: opened.data.snapshot, operationId: 'valid-after-failures', action: { mutation: 'stage-path', path: 'new.txt' } }));
    expect(accepted.status).toBe(200);
    expect((await terminalOperation(service, opened.data.id, 'valid-after-failures')).data.state).toBe('completed');
  }, 30_000);

  test('records a Git-reported cherry-pick conflict as a terminal failure', async () => {
    const directory = await repository();
    const branch = (await git(directory, 'symbolic-ref', '--short', 'HEAD')).trim();
    await git(directory, 'checkout', '-b', 'other');
    await writeFile(join(directory, 'tracked.txt'), 'other\n');
    await git(directory, 'commit', '-am', 'other');
    const other = (await git(directory, 'rev-parse', 'HEAD')).trim();
    await git(directory, 'checkout', branch);
    await writeFile(join(directory, 'tracked.txt'), 'main\n');
    await git(directory, 'commit', '-am', 'main');
    const service = createGitService({ token: 'test-token' });
    const opened = await open(service, directory);

    await service.handle(request('/mutate', { version: 1, requestId: 'cherry-pick', operation: 'mutate', repositoryId: opened.data.id, snapshot: opened.data.snapshot, expectedSnapshot: opened.data.snapshot, operationId: 'conflicting-cherry-pick', action: { mutation: 'cherry-pick', commit: other } }));
    expect((await terminalOperation(service, opened.data.id, 'conflicting-cherry-pick')).data).toMatchObject({ state: 'failed', error: { code: 'conflict' } });
    let journal: Record<string, { state: string }> = {};
    for (let attempt = 0; attempt < 100; attempt += 1) {
      journal = JSON.parse(await Bun.file(join(directory, '.git', 'openchamber-git-graph-operations.json')).text()) as Record<string, { state: string }>;
      if (journal[`${opened.data.id}:conflicting-cherry-pick`]?.state !== 'pending') break;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    expect(journal[`${opened.data.id}:conflicting-cherry-pick`]?.state).toBe('failed');
  });

  test('reports an evicted completed job from its retained operation state', async () => {
    const directory = await repository();
    await writeFile(join(directory, 'first.txt'), 'first\n');
    await writeFile(join(directory, 'second.txt'), 'second\n');
    const service = createGitService({ token: 'test-token', jobMaximum: 1 });
    const opened = await open(service, directory);

    await service.handle(request('/mutate', { version: 1, requestId: 'first', operation: 'mutate', repositoryId: opened.data.id, snapshot: opened.data.snapshot, expectedSnapshot: opened.data.snapshot, operationId: 'first', action: { mutation: 'stage-path', path: 'first.txt' } }));
    const first = await terminalOperation(service, opened.data.id, 'first');
    expect(first.data.state).toBe('completed');
    await service.handle(request('/mutate', { version: 1, requestId: 'second', operation: 'mutate', repositoryId: opened.data.id, snapshot: first.data.snapshot!, expectedSnapshot: first.data.snapshot!, operationId: 'second', action: { mutation: 'stage-path', path: 'second.txt' } }));

    expect((await operation(service, opened.data.id, 'first')).data).toMatchObject({ state: 'completed', snapshot: first.data.snapshot });
  });
});
