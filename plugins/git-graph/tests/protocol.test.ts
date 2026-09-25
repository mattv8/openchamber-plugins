import { describe, expect, test } from 'bun:test';
import { GitGraphRequestSchema, GitGraphResponseSchema } from '../src/shared/protocol.js';

describe('Git Graph service protocol', () => {
  test('accepts a bounded history read with snapshot paging', () => {
    const request = GitGraphRequestSchema.parse({
      version: 1,
      requestId: 'request-1',
      operation: 'read',
      read: 'history',
      repositoryId: 'repo-1',
      snapshot: 'snapshot-1',
      refs: ['HEAD'],
      cursor: null,
      limit: 50,
    });

    if (request.operation !== 'read') throw new Error('history request must be a read');
    expect(request.read).toBe('history');
  });

  test('accepts optional snapshot-bound refs paging fields', () => {
    const request = GitGraphRequestSchema.parse({
      version: 1,
      requestId: 'refs-1',
      operation: 'read',
      read: 'refs',
      repositoryId: 'repo-1',
      snapshot: 'snapshot-1',
      cursor: 'opaque-cursor',
      limit: 200,
    });

    if (request.operation !== 'read' || request.read !== 'refs') throw new Error('refs request expected');
    expect(request.cursor).toBe('opaque-cursor');
    expect(request.limit).toBe(200);
  });

  test('rejects an unstructured mutation payload', () => {
    expect(() => GitGraphRequestSchema.parse({
      version: 1,
      requestId: 'request-1',
      operation: 'mutate',
      repositoryId: 'repo-1',
      operationId: 'operation-1',
      mutation: 'commit',
      args: { message: 'not allowed' },
    })).toThrow();
  });

  test('requires a recognized response payload for each operation', () => {
    expect(() => GitGraphResponseSchema.parse({
      version: 1,
      requestId: 'request-1',
      operation: 'history',
      ok: true,
      data: {},
    })).toThrow();
  });

  test('accepts Git ISO timestamps with a UTC offset', () => {
    expect(() => GitGraphResponseSchema.parse({
      version: 1, requestId: 'history-response', operation: 'jobs/get', ok: true,
      data: { jobId: 'job-1', state: 'completed', result: null, error: null, data: { read: 'history', items: [{ id: 'a'.repeat(40), parentIds: [], subject: 'subject', message: 'subject', author: 'Author', authorEmail: 'author@example.test', timestamp: '2026-09-22T12:00:00+00:00', statistics: { files: 0, insertions: 0, deletions: 0 }, references: [] }], nextCursor: null, hasMore: false, refsSnapshot: 'snapshot-1' } },
    })).not.toThrow();
  });
});
