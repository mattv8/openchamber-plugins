import { describe, expect, test } from 'bun:test';
import { createServiceClient, decodeServiceResponse, requestPathForOperation } from '../../src/panel/host-client.js';
import { GitGraphRequestSchema } from '../../src/shared/protocol.js';

describe('panel host service adapter', () => {
  test('serializes each service operation onto its declared endpoint', () => {
    expect(requestPathForOperation('repo/open')).toBe('/repo/open');
    expect(requestPathForOperation('read')).toBe('/read');
    expect(requestPathForOperation('mutate')).toBe('/mutate');
    expect(requestPathForOperation('jobs/get')).toBe('/jobs/get');
    expect(requestPathForOperation('refresh')).toBe('/refresh');
  });

  test('parses a bounded service response instead of trusting bridge text', () => {
    const parsed = decodeServiceResponse(JSON.stringify({
      version: 1,
      requestId: 'request-1',
      operation: 'refresh',
      ok: true,
      data: { snapshot: 'snapshot-1', changed: false },
    }));
    expect(parsed.ok).toBe(true);
    expect(() => decodeServiceResponse('{"ok":true}')).toThrow('Invalid Git Graph service response');
  });

  test('resolves an accepted read job into the original read envelope', async () => {
    const bodies = [
      { version: 1, requestId: 'read-1', operation: 'read', ok: true, data: { jobId: 'job-1', state: 'queued', acceptedAt: 1 } },
      { version: 1, requestId: 'job:job-1:0', operation: 'jobs/get', ok: true, data: { jobId: 'job-1', state: 'completed', data: { read: 'refs', refs: [], current: null, upstream: null, base: null }, result: null, error: null } },
    ];
    let index = 0;
    const service = createServiceClient({
      serviceRequest: async () => ({ status: 200, body: JSON.stringify(bodies[index++]) }),
    });

    const response = await service.request({ version: 1, requestId: 'read-1', repositoryId: 'repo-1', snapshot: 'snapshot-1', operation: 'read', read: 'refs' });

    expect(response).toEqual({ version: 1, requestId: 'read-1', operation: 'read', ok: true, data: { read: 'refs', refs: [], current: null, upstream: null, base: null } });
  });

  test('aggregates refs pages from sequential jobs without exceeding the bridge response cap', async () => {
    const refs = Array.from({ length: 2500 }, (_, index) => ({ id: `refs/heads/ref-${index}`, name: `ref-${index}`, revision: 'a'.repeat(40), kind: 'local' as const, category: 'branches' as const }));
    const requests: Array<{ path: string; body: string }> = [];
    let job = 0;
    const service = createServiceClient({
      serviceRequest: async ({ path, body }) => {
        const requestBody = body ?? '';
        requests.push({ path, body: requestBody });
        if (path === '/read') {
          job += 1;
          return { status: 200, body: JSON.stringify({ version: 1, requestId: JSON.parse(requestBody).requestId, operation: 'read', ok: true, data: { jobId: `job-${job}`, state: 'queued', acceptedAt: 1 } }) };
        }
        const request = GitGraphRequestSchema.parse(JSON.parse(requestBody));
        if (request.operation !== 'jobs/get') throw new Error('Expected a job poll');
        const page = Number(request.jobId.slice(4)) - 1;
        const start = page * 200;
        const data = { read: 'refs', refs: refs.slice(start, start + 200), current: page === 0 ? { id: 'HEAD', name: 'main', revision: 'a'.repeat(40), kind: 'head', category: 'branches' } : null, upstream: null, base: null, nextCursor: start + 200 < refs.length ? `cursor-${page + 1}` : null };
        return { status: 200, body: JSON.stringify({ version: 1, requestId: request.requestId, operation: 'jobs/get', ok: true, data: { jobId: request.jobId, state: 'completed', data, result: null, error: null } }) };
      },
    });

    const response = await service.request({ version: 1, requestId: 'read-1', repositoryId: 'repo-1', snapshot: 'snapshot-1', operation: 'read', read: 'refs' });

    expect(response).toEqual(expect.objectContaining({ ok: true, data: expect.objectContaining({ refs, current: expect.objectContaining({ id: 'HEAD' }) }) }));
    expect(requests.filter((request) => request.path === '/read')).toHaveLength(13);
    expect(requests.every((request) => Buffer.byteLength(request.body) < 256_000)).toBe(true);
  });

  test('fails closed when a later refs page has a stale snapshot', async () => {
    const bodies = [
      { version: 1, requestId: 'read-1', operation: 'read', ok: true, data: { jobId: 'job-1', state: 'queued', acceptedAt: 1 } },
      { version: 1, requestId: 'job:job-1:0', operation: 'jobs/get', ok: true, data: { jobId: 'job-1', state: 'completed', data: { read: 'refs', refs: [], current: null, upstream: null, base: null, nextCursor: 'cursor-1' }, result: null, error: null } },
      { version: 1, requestId: 'refs:1', operation: 'read', ok: false, error: { code: 'snapshot-conflict', message: 'Read snapshot is stale', retryable: true, snapshot: 'snapshot-2' } },
    ];
    let index = 0;
    const service = createServiceClient({ serviceRequest: async () => ({ status: 200, body: JSON.stringify(bodies[index++]) }) });

    await expect(service.request({ version: 1, requestId: 'read-1', repositoryId: 'repo-1', snapshot: 'snapshot-1', operation: 'read', read: 'refs' })).rejects.toThrow('Git Graph refs page did not resolve successfully');
  });

  test('reports a terminal job error instead of treating it as a successful read', async () => {
    const bodies = [
      { version: 1, requestId: 'read-1', operation: 'read', ok: true, data: { jobId: 'job-1', state: 'queued', acceptedAt: 1 } },
      { version: 1, requestId: 'job:job-1:0', operation: 'jobs/get', ok: true, data: { jobId: 'job-1', state: 'failed', data: null, result: null, error: { code: 'internal', message: 'failed', retryable: false, snapshot: null } } },
    ];
    let index = 0;
    const service = createServiceClient({
      serviceRequest: async () => ({ status: 200, body: JSON.stringify(bodies[index++]) }),
    });

    const response = await service.request({ version: 1, requestId: 'read-1', repositoryId: 'repo-1', snapshot: 'snapshot-1', operation: 'read', read: 'refs' });

    expect(response).toEqual({ version: 1, requestId: 'read-1', operation: 'read', ok: false, error: { code: 'internal', message: 'failed', retryable: false, snapshot: null } });
  });
});
