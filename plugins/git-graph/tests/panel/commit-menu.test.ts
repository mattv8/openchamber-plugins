import type { JsonValue } from '@openchamber/sdk';
import { describe, expect, test } from 'bun:test';
import { buildMenuCheckoutAction, buildMenuCommitAction, menuViewFor, outcomeView, reconcileOperation, recoveryStateForOperation, submitMenuMutation } from '../../src/panel/commit-menu/controller.js';

const commit = 'a'.repeat(40);
const snapshot = 'snapshot';

describe('commit menu mutation controller', () => {
  test('does not force a hard reset until its explicit confirm submission', async () => {
    const draft = buildMenuCommitAction('reset-hard', commit);
    expect(draft?.action).toEqual({ mutation: 'reset', commit, mode: 'hard', force: false });

    const stored: unknown[] = [];
    const requests: unknown[] = [];
    await submitMenuMutation({
      storage: { get: async () => undefined, set: async (_key, value) => { stored.push(value); } },
      service: { request: async (request: unknown) => { requests.push(request); return { ok: true }; } } as never,
      directory: '/repo', repositoryId: 'repo', expectedSnapshot: snapshot,
      intent: draft!, confirmHardReset: true, operationId: 'op:1', now: () => 1,
    });

    expect((stored[0] as { action: unknown }).action).toEqual({ mutation: 'reset', commit, mode: 'hard', force: true });
    expect((requests[0] as { action: unknown }).action).toEqual({ mutation: 'reset', commit, mode: 'hard', force: true });
  });

  test('does not submit when durable storage fails', async () => {
    const requests: unknown[] = [];
    await expect(submitMenuMutation({
      storage: { get: async () => undefined, set: async () => { throw new Error('storage unavailable'); } },
      service: { request: async (request: unknown) => { requests.push(request); return { ok: true }; } } as never,
      directory: '/repo', repositoryId: 'repo', expectedSnapshot: snapshot,
      intent: buildMenuCommitAction('cherry-pick', commit)!, confirmHardReset: false, operationId: 'op:2', now: () => 1,
    })).rejects.toThrow('storage unavailable');
    expect(requests).toEqual([]);
  });

  test('maps operation queries without treating unknown state as a retry', () => {
    expect(recoveryStateForOperation('running')).toEqual({ state: 'running' });
    expect(recoveryStateForOperation('completed')).toEqual({ state: 'completed' });
    expect(recoveryStateForOperation('failed', 'bad ref')).toEqual({ state: 'failed', message: 'bad ref' });
    expect(recoveryStateForOperation('unknown')).toEqual({ state: 'unknown' });
    expect(recoveryStateForOperation('absent')).toEqual({ state: 'unknown' });
  });

  test('labels checkout with its sole local branch or detached SHA', () => {
    expect(buildMenuCheckoutAction(commit, ['main']).label).toBe('Checkout main');
    expect(buildMenuCheckoutAction(commit, []).label).toBe('Checkout detached');
    expect(buildMenuCheckoutAction(commit, []).action).toEqual({ mutation: 'checkout', branch: commit });
  });

  test('refuses to submit while an unresolved operation record exists', async () => {
    const requests: unknown[] = [];
    await expect(submitMenuMutation({
      storage: { get: async () => ({ operationId: 'old' }), set: async () => { throw new Error('must not write'); } },
      service: { request: async (request: unknown) => { requests.push(request); return { ok: true }; } } as never,
      directory: '/repo', repositoryId: 'repo', expectedSnapshot: snapshot,
      intent: buildMenuCommitAction('cherry-pick', commit)!, confirmHardReset: false, operationId: 'op:3', now: () => 1,
    })).rejects.toThrow('not submitted');
    expect(requests).toEqual([]);
  });

  test('continues polling a replacement record until it reaches a terminal state', async () => {
    let record: JsonValue = { v: 1, repositoryId: 'repo', operationId: 'x', directory: '/repo' };
    const deleted: string[] = [];
    const result = await reconcileOperation({ repositoryId: 'repo', storage: { get: async () => record, delete: async (key) => { deleted.push(key); } }, query: async (id) => { if (id === 'x') { record = { v: 1, repositoryId: 'repo', operationId: 'y', directory: '/repo' }; return { state: 'completed', error: null }; } return { state: 'completed', error: null }; }, sleep: async () => {}, now: () => 0, isActive: () => true });
    expect(result).toEqual({ state: 'completed' });
    expect(deleted).toEqual(['git-graph:op:repo']);
  });

  test('maps child outcomes without retrying writes', () => {
    expect(outcomeView({ ok: false, code: 'snapshot-conflict' })).toEqual({ view: 'failure', messageKey: 'menu.repoChanged' });
    expect(outcomeView({ ok: false, code: 'conflict' })).toEqual({ view: 'conflict' });
    expect(outcomeView({ ok: false, code: 'job-lost' })).toEqual({ view: 'unknown' });
    expect(outcomeView(new Error('storage failure'))).toEqual({ view: 'not-submitted', messageKey: 'menu.notSubmitted' });
  });

  test('(b) query running, running, then completed settles completed, calls sleep between polls, deletes exactly once', async () => {
    const record: JsonValue = { v: 1, repositoryId: 'repo', operationId: 'op-b', directory: '/repo' };
    const deleted: string[] = [];
    const sleeps: number[] = [];
    let poll = 0;

    const result = await reconcileOperation({
      repositoryId: 'repo',
      storage: {
        get: async () => record,
        delete: async (key) => { deleted.push(key); },
      },
      query: async () => {
        poll += 1;
        if (poll === 1 || poll === 2) return { state: 'running', error: null };
        return { state: 'completed', error: null };
      },
      sleep: async (ms) => { sleeps.push(ms); },
      now: () => 0,
      isActive: () => true,
    });

    expect(result).toEqual({ state: 'completed' });
    expect(sleeps.length).toBe(2);
    expect(sleeps[0]).toBe(500); // 500 * 2^0
    expect(sleeps[1]).toBe(1000); // 500 * 2^1
    expect(deleted).toEqual(['git-graph:op:repo']);
  });

  test('(c) query absent returns unknown, no delete', async () => {
    const deleted: string[] = [];

    const result = await reconcileOperation({
      repositoryId: 'repo',
      storage: {
        get: async () => ({ v: 1, repositoryId: 'repo', operationId: 'op-c', directory: '/repo' }),
        delete: async (key) => { deleted.push(key); },
      },
      query: async () => {
        return { state: 'absent', error: null };
      },
      sleep: async () => {},
      now: () => 0,
      isActive: () => true,
    });

    expect(result).toEqual({ state: 'unknown' });
    expect(deleted).toEqual([]);
  });

  test('(c) query unknown returns unknown, no delete', async () => {
    const deleted: string[] = [];

    const result = await reconcileOperation({
      repositoryId: 'repo',
      storage: {
        get: async () => ({ v: 1, repositoryId: 'repo', operationId: 'op-c-unk', directory: '/repo' }),
        delete: async (key) => { deleted.push(key); },
      },
      query: async () => {
        return { state: 'unknown', error: null };
      },
      sleep: async () => {},
      now: () => 0,
      isActive: () => true,
    });

    expect(result).toEqual({ state: 'unknown' });
    expect(deleted).toEqual([]);
  });

  test('(d) running forever until 10-minute cap advances fake clock, returns unknown, no delete', async () => {
    const deleted: string[] = [];
    const sleeps: number[] = [];
    let currentTime = 0;

    const result = await reconcileOperation({
      repositoryId: 'repo',
      storage: {
        get: async () => ({ v: 1, repositoryId: 'repo', operationId: 'op-d', directory: '/repo' }),
        delete: async (key) => { deleted.push(key); },
      },
      query: async () => {
        return { state: 'running', error: null };
      },
      sleep: async (ms) => {
        sleeps.push(ms);
        currentTime += ms;
      },
      now: () => currentTime,
      isActive: () => true,
    });

    expect(result).toEqual({ state: 'unknown' });
    expect(deleted).toEqual([]);
    expect(sleeps.length).toBeGreaterThan(0);
    expect(currentTime).toBeGreaterThanOrEqual(600_000);
  });

  test('(e) stored record for another repositoryId returns idle, no query', async () => {
    const deleted: string[] = [];
    let queryCount = 0;

    const result = await reconcileOperation({
      repositoryId: 'repo-current',
      storage: {
        get: async () => ({ v: 1, repositoryId: 'repo-other', operationId: 'op-e', directory: '/repo' }),
        delete: async (key) => { deleted.push(key); },
      },
      query: async () => {
        queryCount += 1;
        return { state: 'running', error: null };
      },
      sleep: async () => {},
      now: () => 0,
      isActive: () => true,
    });

    expect(result).toEqual({ state: 'idle' });
    expect(queryCount).toBe(0);
    expect(deleted).toEqual([]);
  });

  test('(g) outcomeView for timeout-unknown returns unknown', () => {
    expect(outcomeView({ ok: false, code: 'timeout-unknown' })).toEqual({ view: 'unknown' });
  });

  test('shows only attention recovery while Git needs attention', () => {
    expect(menuViewFor({ attention: 'merge' })).toBe('conflict');
    expect(menuViewFor({ attention: 'bisect' })).toBe('conflict');
    expect(menuViewFor({ attention: null })).toBe('menu');
  });
});
