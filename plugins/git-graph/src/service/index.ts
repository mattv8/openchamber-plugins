import { createHash, randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import path from 'node:path';
import { GitGraphRequestSchema, GitGraphResponseSchema, PROTOCOL_VERSION, type GitGraphMutation, type GitGraphRequest, type GitGraphResponse } from '../shared/protocol.js';
import { ServiceError, type HunkRecord, type Repository, type ServiceContext } from './contracts.js';
import { createJobStore } from './jobs.js';
import { mutateRepository } from './mutations.js';
import { openRepository, refreshRepository } from './repository.js';
import { readRepository } from './reads.js';
import { createGitRunner } from './runner.js';
import { createRepositoryWatcher } from './watcher.js';

const MAX_INPUT_BYTES = 64_000;
const MAX_RESPONSE_BYTES = 256_000;
const MAX_REPOSITORIES = 64;
const MAX_HUNKS = 2_000;
const MAX_OPERATIONS = 256;
type MutationData = { operationId: string; snapshot: string; result: { state: 'completed' | 'conflict'; message: string | null } };
type JobData = Exclude<Extract<GitGraphResponse, { ok: true; operation: 'read' }>['data'], { jobId: string }> | MutationData;
type Operation = { repositoryId: string; identity: string; jobId: string; createdAt: number; state: 'pending' | 'completed' | 'unknown'; snapshot: string | null };
type Journal = Record<string, Operation>;

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const responseHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const operationForPath: Record<string, GitGraphRequest['operation']> = { '/repo/open': 'repo/open', '/read': 'read', '/mutate': 'mutate', '/jobs/get': 'jobs/get', '/refresh': 'refresh' };

function publicError(caught: unknown): ServiceError {
  return caught instanceof ServiceError ? caught : new ServiceError('internal', 'Internal service error');
}

function json(value: unknown, status = 200): Response {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
    const source = value as { requestId?: string; operation?: GitGraphRequest['operation'] };
    return new Response(JSON.stringify({ version: PROTOCOL_VERSION, requestId: source.requestId ?? 'response-too-large', operation: source.operation ?? 'read', ok: false, error: { code: 'unsupported', message: 'Response exceeds transport limit; request a smaller page', retryable: false, snapshot: null } }), { status: 413, headers: responseHeaders });
  }
  return new Response(body, { status, headers: responseHeaders });
}

function failure(requestId: string, operation: GitGraphRequest['operation'], caught: unknown): Response {
  const error = publicError(caught);
  const status = error.code === 'not-a-repository' || error.code === 'not-found' ? 404 : ['repository-busy', 'snapshot-conflict', 'conflict'].includes(error.code) ? 409 : error.code === 'timeout-unknown' ? 504 : 400;
  return json({ version: PROTOCOL_VERSION, requestId, operation, ok: false, error: { code: error.code, message: error.message.slice(0, 4096), retryable: error.retryable, snapshot: null } }, status);
}

async function boundedBody(request: Request): Promise<string> {
  const length = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(length) && length > MAX_INPUT_BYTES) throw new ServiceError('invalid-request', 'Request exceeds transport limit');
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      received += part.value.byteLength;
      if (received > MAX_INPUT_BYTES) { await reader.cancel(); throw new ServiceError('invalid-request', 'Request exceeds transport limit'); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

async function readIncomingBody(request: IncomingMessage): Promise<Buffer> {
  const length = Number(request.headers['content-length'] ?? '0');
  if (Number.isFinite(length) && length > MAX_INPUT_BYTES) throw new ServiceError('invalid-request', 'Request exceeds transport limit');
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    received += chunk.byteLength;
    if (received > MAX_INPUT_BYTES) { request.destroy(); throw new ServiceError('invalid-request', 'Request exceeds transport limit'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createGitService({ token = randomUUID(), timeoutMs = 20_000 }: { token?: string; timeoutMs?: number } = {}) {
  const repositories = new Map<string, Repository>();
  const hunks = new Map<string, HunkRecord>();
  const queues = new Map<string, Promise<void>>();
  const operations = new Map<string, Operation>();
  const jobRepositories = new Map<string, string>();
  const journalQueues = new Map<string, Promise<void>>();
  const submissions = new Map<string, Promise<MutationData | { jobId: string; state: 'queued' | 'running'; acceptedAt: number }>>();
  let closed = false;
  const runGit = createGitRunner(timeoutMs);
  const jobs = createJobStore<JobData>();
  const watcher = createRepositoryWatcher((repositoryId) => { const repository = repositories.get(repositoryId); if (repository) void refreshRepository(repository, runGit).catch(() => undefined); });
  const context: ServiceContext = {
    runGit,
    refresh: (repository) => refreshRepository(repository, runGit),
    rememberHunk: (key, hunk) => { hunks.set(key, hunk); while (hunks.size > MAX_HUNKS) hunks.delete(hunks.keys().next().value as string); },
    getHunk: (key) => hunks.get(key),
  };
  const journalPath = (repository: Repository) => path.join(repository.commonGitDir, 'openchamber-git-graph-operations.json');
  const operationKey = (repository: Repository, operationId: string) => `${repository.id}:${operationId}`;
  const isOperation = (value: unknown): value is Operation => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as { repositoryId?: unknown; identity?: unknown; jobId?: unknown; createdAt?: unknown; state?: unknown; snapshot?: unknown };
    return typeof record.repositoryId === 'string' && typeof record.identity === 'string' && typeof record.jobId === 'string' && Number.isSafeInteger(record.createdAt) && ['pending', 'completed', 'unknown'].includes(String(record.state)) && (typeof record.snapshot === 'string' || record.snapshot === null);
  };
  const loadJournal = async (repository: Repository): Promise<Journal> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(journalPath(repository), 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ServiceError('internal', 'Operation journal is invalid');
      const entries = Object.entries(parsed).filter(([key, value]) => key.length <= 256 && isOperation(value));
      if (entries.length !== Object.keys(parsed).length) throw new ServiceError('internal', 'Operation journal is invalid');
      return Object.fromEntries(entries);
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw new ServiceError('internal', 'Unable to read operation journal'); }
  };
  const saveJournal = async (repository: Repository, journal: Journal) => {
    const entries = Object.entries(journal).sort(([, a], [, b]) => b.createdAt - a.createdAt).slice(0, MAX_OPERATIONS);
    const temporary = `${journalPath(repository)}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(Object.fromEntries(entries)), { mode: 0o600 });
    await rename(temporary, journalPath(repository));
  };
  const journalTransaction = async <T>(repository: Repository, action: () => Promise<T>): Promise<T> => {
    const previous = journalQueues.get(repository.commonGitDir) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current); journalQueues.set(repository.commonGitDir, tail);
    await previous;
    try { return await action(); } finally { release(); if (journalQueues.get(repository.commonGitDir) === tail) journalQueues.delete(repository.commonGitDir); }
  };
  const serialized = async <T>(repository: Repository, work: () => Promise<T>): Promise<T> => {
    const previous = queues.get(repository.commonGitDir) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    queues.set(repository.commonGitDir, tail);
    await previous;
    try { return await work(); }
    finally { release(); if (queues.get(repository.commonGitDir) === tail) queues.delete(repository.commonGitDir); }
  };
  const repositoryFor = (id: string) => {
    const repository = repositories.get(id);
    if (!repository) throw new ServiceError('not-found', 'Repository must be opened before use');
    watcher.ensure(repository.id, repository.gitDir); return repository;
  };
  const rememberRepository = (repository: Repository) => { repositories.set(repository.id, repository); while (repositories.size > MAX_REPOSITORIES) repositories.delete(repositories.keys().next().value as string); watcher.ensure(repository.id, repository.gitDir); };
  const submitRead = (repository: Repository, request: Extract<GitGraphRequest, { operation: 'read' }>) => {
    const accepted = jobs.submit(async () => { await context.refresh(repository); if (request.snapshot !== repository.snapshot) throw new ServiceError('snapshot-conflict', 'Read snapshot is stale', true); return readRepository(context, repository, request); });
    jobRepositories.set(accepted.jobId, repository.id); return accepted;
  };
  const submitMutationImpl = async (repository: Repository, request: Extract<GitGraphRequest, { operation: 'mutate' }>) => {
    const key = operationKey(repository, request.operationId);
    const identity = digest(JSON.stringify({ expectedSnapshot: request.expectedSnapshot, action: request.action }));
    const inMemory = operations.get(key);
    if (inMemory) {
      if (inMemory.identity !== identity) throw new ServiceError('conflict', 'Operation ID was reused with another payload');
      if (inMemory.state === 'completed' && inMemory.snapshot) return { operationId: request.operationId, snapshot: inMemory.snapshot, result: { state: 'completed' as const, message: null } };
      return { jobId: inMemory.jobId, state: 'running' as const, acceptedAt: inMemory.createdAt };
    }
    const reserved: Operation = { repositoryId: repository.id, identity, jobId: randomUUID().replaceAll('-', ''), createdAt: Date.now(), state: 'pending', snapshot: null };
    operations.set(key, reserved);
    while (operations.size > MAX_OPERATIONS) {
      const candidate = [...operations.entries()].find(([, value]) => value.state !== 'pending');
      if (!candidate) { operations.delete(key); throw new ServiceError('repository-busy', 'Service operation capacity is full', true); }
      operations.delete(candidate[0]);
    }
    const remembered = await journalTransaction(repository, async () => {
      const journal = await loadJournal(repository);
      const found = journal[key];
      if (found) return found;
      await saveJournal(repository, { ...journal, [key]: reserved });
      return undefined;
    });
    if (remembered) {
      if (remembered.identity !== identity) throw new ServiceError('conflict', 'Operation ID was reused with another payload');
      operations.delete(key);
      if (remembered.repositoryId !== repository.id || remembered.state !== 'completed' || !remembered.snapshot) throw new ServiceError('timeout-unknown', 'Operation outcome is unknown after service restart', true);
      return { operationId: request.operationId, snapshot: remembered.snapshot, result: { state: 'completed' as const, message: null } };
    }
    if (closed) { operations.delete(key); throw new ServiceError('internal', 'Service is closed'); }
    const accepted = jobs.submit(async () => serialized(repository, async () => {
      await context.refresh(repository);
      if (repository.snapshot !== request.expectedSnapshot) throw new ServiceError('snapshot-conflict', 'Repository changed; refresh before mutating', true);
      await mutateRepository(context, repository, request.action as GitGraphMutation);
      await context.refresh(repository);
      reserved.state = 'completed'; reserved.snapshot = repository.snapshot;
      if (!closed) await journalTransaction(repository, async () => { const journal = await loadJournal(repository); await saveJournal(repository, { ...journal, [key]: reserved }); });
      return { operationId: request.operationId, snapshot: repository.snapshot, result: { state: 'completed' as const, message: null } };
    }));
    reserved.jobId = accepted.jobId;
    jobRepositories.set(accepted.jobId, repository.id);
    return { ...accepted, jobId: accepted.jobId, state: accepted.state };
  };
  const submitMutation = (repository: Repository, request: Extract<GitGraphRequest, { operation: 'mutate' }>) => {
    const key = operationKey(repository, request.operationId);
    const current = submissions.get(key);
    if (current) return current;
    const submission = submitMutationImpl(repository, request).finally(() => submissions.delete(key));
    submissions.set(key, submission);
    return submission;
  };
  const handle = async (request: Request): Promise<Response> => {
    if (closed) return failure('closed', 'read', new ServiceError('internal', 'Service is closed'));
    if (request.headers.get('authorization') !== `Bearer ${token}`) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: responseHeaders });
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') return json({ ok: true, version: PROTOCOL_VERSION });
    const expectedOperation = operationForPath[url.pathname];
    if (!expectedOperation) return new Response(null, { status: 404 });
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
    let parsed: GitGraphRequest;
    try { parsed = GitGraphRequestSchema.parse(JSON.parse(await boundedBody(request))); }
    catch (caught) { return failure('invalid', expectedOperation, caught instanceof ServiceError ? caught : new ServiceError('invalid-request', 'Invalid request')); }
    if (parsed.operation !== expectedOperation) return failure(parsed.requestId, parsed.operation, new ServiceError('invalid-request', 'Request operation does not match route'));
    try {
      let body: GitGraphResponse;
      if (parsed.operation === 'repo/open') {
        const repository = await openRepository(parsed.directory, runGit); rememberRepository(repository);
        const head = await runGit(repository.root, ['rev-parse', '--verify', 'HEAD']);
        body = { version: PROTOCOL_VERSION, requestId: parsed.requestId, operation: parsed.operation, ok: true, data: { ...repository, head: head.exitCode === 0 ? head.stdout.toString('utf8').trim() : null } };
      } else if (parsed.operation === 'read') {
        const repository = repositoryFor(parsed.repositoryId);
        if (parsed.snapshot !== repository.snapshot) throw new ServiceError('snapshot-conflict', 'Read snapshot is stale', true);
        body = { version: PROTOCOL_VERSION, requestId: parsed.requestId, operation: parsed.operation, ok: true, data: submitRead(repository, parsed) } as GitGraphResponse;
      } else if (parsed.operation === 'mutate') {
        body = { version: PROTOCOL_VERSION, requestId: parsed.requestId, operation: parsed.operation, ok: true, data: await submitMutation(repositoryFor(parsed.repositoryId), parsed) };
      } else if (parsed.operation === 'refresh') {
        const repository = repositoryFor(parsed.repositoryId); const previous = repository.snapshot; await context.refresh(repository);
        body = { version: PROTOCOL_VERSION, requestId: parsed.requestId, operation: parsed.operation, ok: true, data: { snapshot: repository.snapshot, changed: previous !== repository.snapshot } };
      } else {
        if (jobRepositories.get(parsed.jobId) !== parsed.repositoryId) throw new ServiceError('not-found', 'Job was not found for this repository');
        const job = jobs.get(parsed.jobId);
        if (!job) body = { version: PROTOCOL_VERSION, requestId: parsed.requestId, operation: parsed.operation, ok: true, data: { jobId: parsed.jobId, state: 'unknown', data: null, result: null, error: { code: 'job-lost', message: 'Job was not retained by this service instance', retryable: false, snapshot: null } } };
        else if (job.state === 'queued' || job.state === 'running') body = { version: PROTOCOL_VERSION, requestId: parsed.requestId, operation: parsed.operation, ok: true, data: { jobId: job.id, state: job.state, data: null, result: null, error: null } };
        else if (job.state === 'completed') body = { version: PROTOCOL_VERSION, requestId: parsed.requestId, operation: parsed.operation, ok: true, data: { jobId: job.id, state: 'completed', data: job.data, result: 'operationId' in job.data ? { operationId: job.data.operationId, snapshot: job.data.snapshot } : null, error: null } };
        else if (job.state === 'failed' || job.state === 'unknown') body = { version: PROTOCOL_VERSION, requestId: parsed.requestId, operation: parsed.operation, ok: true, data: { jobId: job.id, state: job.state, data: null, result: null, error: { code: job.error.code, message: job.error.message, retryable: job.error.retryable, snapshot: null } } };
        else throw new ServiceError('internal', 'Invalid job state');
      }
      GitGraphResponseSchema.parse(body);
      return json(body);
    } catch (caught) { return failure(parsed.requestId, parsed.operation, caught); }
  };
  return { token, handle, close: () => { closed = true; watcher.close(); jobs.close(); runGit.close(); repositories.clear(); hunks.clear(); operations.clear(); jobRepositories.clear(); submissions.clear(); } };
}

/** Starts only on loopback; the bearer is never logged or inherited by Git. */
export async function startGitService(options: { token?: string; timeoutMs?: number; port?: number } = {}) {
  const service = createGitService(options);
  const server = createServer(async (incoming, outgoing) => {
    try {
      const body = ['GET', 'HEAD'].includes(incoming.method ?? '') ? undefined : await readIncomingBody(incoming);
      const init: RequestInit = { method: incoming.method ?? 'GET', headers: incoming.headers as HeadersInit };
      if (body) init.body = body.toString('utf8');
      const request = new Request(`http://127.0.0.1${incoming.url ?? '/'}`, init);
      const response = await service.handle(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (caught) { const response = failure('invalid', 'read', caught); outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer())); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback server did not provide a TCP address');
  return { service, port: address.port, close: async () => { service.close(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); } };
}

export { createRepositoryWatcher } from './watcher.js';
