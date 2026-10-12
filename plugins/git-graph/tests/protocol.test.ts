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

  test('accepts snapshot-scoped commit-summary and remotes reads', () => {
    const base = { version: 1, requestId: 'summary-1', operation: 'read', repositoryId: 'repo-1', snapshot: 'snapshot-1' };
    expect(() => GitGraphRequestSchema.parse({ ...base, read: 'commit-summary', commit: 'a'.repeat(40) })).not.toThrow();
    expect(() => GitGraphRequestSchema.parse({ ...base, read: 'remotes' })).not.toThrow();
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

  test('distinguishes linked, unlinked, and unavailable commit author responses', () => {
    const base = { version: 1, requestId: 'author-response', operation: 'read', ok: true, data: { read: 'commit-author' } };
    const author = { login: 'octocat', avatarUrl: 'https://avatars.githubusercontent.com/u/583231?v=4' };
    expect(() => GitGraphResponseSchema.parse({ ...base, data: { ...base.data, resolution: 'linked', author } })).not.toThrow();
    expect(() => GitGraphResponseSchema.parse({ ...base, data: { ...base.data, resolution: 'linked', author, fetchedAt: 0 } })).not.toThrow();
    expect(() => GitGraphResponseSchema.parse({ ...base, data: { ...base.data, resolution: 'unlinked', author: null } })).not.toThrow();
    expect(() => GitGraphResponseSchema.parse({ ...base, data: { ...base.data, resolution: 'unlinked', author: null, fetchedAt: 1 } })).not.toThrow();
    expect(() => GitGraphResponseSchema.parse({ ...base, data: { ...base.data, resolution: 'unavailable', author: null } })).not.toThrow();
    expect(() => GitGraphResponseSchema.parse({ ...base, data: { ...base.data, resolution: 'linked', author, fetchedAt: 1.5 } })).toThrow();
    expect(() => GitGraphResponseSchema.parse({ ...base, data: { ...base.data, resolution: 'linked', author: null } })).toThrow();
    expect(() => GitGraphResponseSchema.parse({ ...base, data: { ...base.data, resolution: 'unlinked', author } })).toThrow();
  });

  test('accepts Git ISO timestamps with a UTC offset', () => {
    expect(() => GitGraphResponseSchema.parse({
      version: 1, requestId: 'history-response', operation: 'jobs/get', ok: true,
      data: { jobId: 'job-1', state: 'completed', result: null, error: null, data: { read: 'history', items: [{ id: 'a'.repeat(40), parentIds: [], subject: 'subject', message: 'subject', author: 'Author', authorEmail: 'author@example.test', timestamp: '2026-09-22T12:00:00+00:00', statistics: { files: 0, insertions: 0, deletions: 0 }, references: [] }], nextCursor: null, hasMore: false, refsSnapshot: 'snapshot-1' } },
    })).not.toThrow();
  });
});
