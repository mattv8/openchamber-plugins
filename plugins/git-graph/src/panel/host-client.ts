import { connectHost, type HostClient } from '@openchamber/sdk';
import { GitGraphResponseSchema, type GitGraphRequest, type GitGraphResponse } from '../shared/protocol.js';
import type { GitGraphServiceClient, PanelHost, ResolvedGitGraphResponse } from './domain/index.js';

const paths = {
  'repo/open': '/repo/open',
  read: '/read',
  mutate: '/mutate',
  'jobs/get': '/jobs/get',
  refresh: '/refresh',
} as const;

export const requestPathForOperation = (operation: GitGraphRequest['operation']): string => paths[operation];

export const decodeServiceResponse = (body: string): GitGraphResponse => {
  try {
    return GitGraphResponseSchema.parse(JSON.parse(body));
  } catch {
    throw new Error('Invalid Git Graph service response');
  }
};

type ReadResponse = Extract<GitGraphResponse, { ok: true; operation: 'read' }>;
type MutationResponse = Extract<GitGraphResponse, { ok: true; operation: 'mutate' }>;

const isJobReference = (data: ReadResponse['data'] | MutationResponse['data']): data is { jobId: string; state: 'queued' | 'running'; acceptedAt: number } => 'jobId' in data;
const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
const jobError = (request: GitGraphRequest, message: string): ResolvedGitGraphResponse => ({
  version: 1,
  requestId: request.requestId,
  operation: request.operation,
  ok: false,
  error: { code: 'job-lost', message, retryable: false, snapshot: 'snapshot' in request ? request.snapshot : null },
});
const resolveRead = (host: Pick<HostClient, 'serviceRequest'>, request: Extract<GitGraphRequest, { operation: 'read' }>, response: ReadResponse): Promise<ResolvedGitGraphResponse> => {
  if (isJobReference(response.data)) return waitForTerminalJob(host, request, response.data.jobId);
  return Promise.resolve({ version: 1, requestId: response.requestId, operation: 'read', ok: true, data: response.data });
};
const resolveMutation = (host: Pick<HostClient, 'serviceRequest'>, request: Extract<GitGraphRequest, { operation: 'mutate' }>, response: MutationResponse): Promise<ResolvedGitGraphResponse> => {
  if (isJobReference(response.data)) return waitForTerminalJob(host, request, response.data.jobId);
  return Promise.resolve({ version: 1, requestId: response.requestId, operation: 'mutate', ok: true, data: response.data });
};

const MAX_AGGREGATED_REFS = 10_000;

const resolveRefsPages = async (
  host: Pick<HostClient, 'serviceRequest'>,
  request: Extract<GitGraphRequest, { operation: 'read'; read: 'refs' }>,
  first: ResolvedGitGraphResponse,
): Promise<ResolvedGitGraphResponse> => {
  if (!first.ok || first.operation !== 'read' || first.data.read !== 'refs' || !first.data.nextCursor) return first;
  const refs = [...first.data.refs];
  let cursor: string | null = first.data.nextCursor;
  let page = 1;
  while (cursor) {
    if (refs.length >= MAX_AGGREGATED_REFS) throw new Error('Git Graph reference set exceeds the supported aggregation limit');
    const pageRequest = { ...request, requestId: `refs:${page}`, cursor, limit: request.limit ?? 200 };
    const result = await host.serviceRequest({ method: 'POST', path: paths.read, body: JSON.stringify(pageRequest) });
    const response = decodeServiceResponse(result.body);
    if (response.requestId !== pageRequest.requestId || response.operation !== 'read' || !response.ok) throw new Error('Git Graph refs page did not resolve successfully');
    const resolved = await resolveRead(host, pageRequest, response);
    if (!resolved.ok || resolved.operation !== 'read' || resolved.data.read !== 'refs') throw new Error('Git Graph refs page did not resolve successfully');
    const nextCursor = resolved.data.nextCursor;
    if (nextCursor === cursor) throw new Error('Git Graph refs page cursor did not advance');
    refs.push(...resolved.data.refs);
    if (refs.length > MAX_AGGREGATED_REFS) throw new Error('Git Graph reference set exceeds the supported aggregation limit');
    cursor = nextCursor ?? null;
    page += 1;
  }
  return { ...first, data: { ...first.data, refs, nextCursor: null } };
};

export const createServiceClient = (host: Pick<HostClient, 'serviceRequest'>): GitGraphServiceClient => ({
  async request(request) {
    const result = await host.serviceRequest({
      method: 'POST',
      path: requestPathForOperation(request.operation),
      body: JSON.stringify(request),
    });
    const response = decodeServiceResponse(result.body);
    if (response.requestId !== request.requestId || response.operation !== request.operation) throw new Error('Git Graph service response did not match its request');
    if (!response.ok || response.operation === 'repo/open' || response.operation === 'refresh' || response.operation === 'jobs/get') return response;
    if (response.operation === 'read') {
      if (request.operation !== 'read') throw new Error('Git Graph read response did not match its request');
      const resolved = await resolveRead(host, request, response);
      return request.read === 'refs' ? resolveRefsPages(host, request, resolved) : resolved;
    }
    if (request.operation !== 'mutate') throw new Error('Git Graph mutation response did not match its request');
    return resolveMutation(host, request, response);
  },
});

export const createPanelHost = (
  host: Pick<HostClient, 'toast' | 'writeClipboard' | 'openUrl'>,
  confirm: NonNullable<PanelHost['confirm']>,
): PanelHost => ({
  toast: (message, kind = 'info') => { void host.toast({ message, kind }); },
  copy: (value) => host.writeClipboard(value),
  openUrl: (url) => host.openUrl(url),
  confirm,
});

export const connectGitGraphHost = (): HostClient => connectHost();

/** Polls an accepted job only until it becomes terminal; callers must never resubmit it. */
export const waitForTerminalJob = async (
  host: Pick<HostClient, 'serviceRequest'>,
  request: Extract<GitGraphRequest, { operation: 'read' | 'mutate' }>,
  jobId: string,
  maximumPolls = 120,
): Promise<ResolvedGitGraphResponse> => {
  for (let index = 0; index < maximumPolls; index += 1) {
    await wait(Math.min(100 * (2 ** index), 1000));
    const requestId = `job:${jobId}:${index}`;
    const result = await host.serviceRequest({ method: 'POST', path: paths['jobs/get'], body: JSON.stringify({ version: 1, requestId, repositoryId: request.repositoryId, operation: 'jobs/get', jobId }) });
    const response = decodeServiceResponse(result.body);
    if (response.requestId !== requestId || response.operation !== 'jobs/get') throw new Error('Git Graph job response did not match its request');
    if (!response.ok) return { ...response, requestId: request.requestId, operation: request.operation };
    if (response.data.jobId !== jobId) throw new Error('Git Graph job response did not match its job');
    if (response.data.state === 'queued' || response.data.state === 'running') continue;
    if (response.data.state !== 'completed' || !response.data.data) return { version: 1, requestId: request.requestId, operation: request.operation, ok: false, error: response.data.error ?? { code: 'job-lost', message: 'Git Graph job did not retain a terminal result', retryable: false, snapshot: 'snapshot' in request ? request.snapshot : null } };
    if (request.operation === 'read') {
      if (!('read' in response.data.data) || response.data.data.read !== request.read) return jobError(request, 'Git Graph job result did not match its read request');
      return { version: 1, requestId: request.requestId, operation: 'read', ok: true, data: response.data.data };
    }
    if (!('operationId' in response.data.data) || response.data.data.operationId !== request.operationId) return jobError(request, 'Git Graph job result did not match its mutation request');
    return { version: 1, requestId: request.requestId, operation: 'mutate', ok: true, data: response.data.data };
  }
  return jobError(request, 'Git Graph job did not reach a terminal state');
};
