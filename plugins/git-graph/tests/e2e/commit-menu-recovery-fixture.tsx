import { createRoot } from 'react-dom/client';
import { useEffect } from 'react';
import type { JsonValue } from '@openchamber/sdk';
import { createFixtureHost } from './host-fixture.js';
import { useOperationRecovery, CommitMenuView } from '../../src/panel/commit-menu/view.js';
import { GitGraphRequestSchema, GitGraphResponseSchema, type GitGraphRequest } from '../../src/shared/protocol.js';
import type { GitGraphServiceClient, ResolvedGitGraphResponse } from '../../src/panel/domain/index.js';
import '../../src/panel/styles/menu.css';

const scenario = new URL(location.href).searchParams.get('scenario') ?? 'acknowledge-unknown';
const commit = 'a'.repeat(40);

const isRecoveryScenario = scenario.startsWith('stored-') || scenario === 'running-first-poll';
let stored: JsonValue | undefined = isRecoveryScenario ? { v: 1, directory: '/repo', repositoryId: 'repo', operationId: 'recovery-op', label: 'Fixture', expectedSnapshot: 'snap', action: { mutation: 'fetch', remote: 'origin' }, createdAt: Date.now() } : undefined;
let deletes = 0;
let settled = 0;
let operationQueries = 0;
const recoveryStates: string[] = [];
const mutationAttempts: string[] = [];
const deleteFailures = scenario === 'cleanup-delete-failure';
const failFirstOperationQuery = scenario === 'running-first-poll';
const returnConflictFailure = scenario === 'mapped-failure-conflict';
const returnTimeoutUnknown = scenario === 'unknown-timeout';

let refreshed = false;
const attention = (): 'merge' | 'rebase' | null => {
  if (scenario === 'attention-cleared' && refreshed) return null;
  if (scenario === 'attention-changed' && refreshed) return 'rebase';
  return scenario.startsWith('merge-') || scenario.startsWith('attention-') ? 'merge' : null;
};
const mutations: Extract<GitGraphRequest, { operation: 'mutate' }>[] = [];
const status = () => ({ current: 'main', tracking: null, ahead: 0, behind: 0, isClean: true, files: [], attention: attention() });

const respond = async (request: GitGraphRequest): Promise<ResolvedGitGraphResponse> => {
    if (request.operation === 'operations/get') {
      operationQueries += 1;
      // Scenario: running first poll returns running, then unknown on second poll
      if (failFirstOperationQuery && operationQueries === 1) {
        return { version: 1, requestId: request.requestId, operation: 'operations/get', ok: true, data: { operationId: request.operationId, state: 'running', jobId: 'job-1', snapshot: null, error: null } };
      }
      return { version: 1, requestId: request.requestId, operation: 'operations/get', ok: true, data: { operationId: request.operationId, state: 'unknown', jobId: null, snapshot: null, error: null } };
    }
    if (request.operation === 'repo/open') {
      return { version: 1, requestId: request.requestId, operation: 'repo/open', ok: true, data: { id: 'repo', root: '/repo', commonGitDir: '/repo/.git', head: commit, snapshot: 'snap' } };
    }
    if (request.operation === 'refresh') {
      refreshed = true;
      return { version: 1, requestId: request.requestId, operation: 'refresh', ok: true, data: { snapshot: 'reviewed-snap', changed: true } };
    }
    if (request.operation === 'read') {
      if (scenario === 'initial-status-error') throw new Error('status transport failed');
      return { version: 1, requestId: request.requestId, operation: 'read', ok: true, data: { read: 'status', status: status() } };
    }
    if (request.operation === 'mutate') {
      mutations.push(request);
      mutationAttempts.push(request.action.mutation);
      if (scenario === 'mutate-transport-error') throw new Error('connection lost after submission');
      // snapshot-conflict failure
      if (returnConflictFailure) {
        return { version: 1, requestId: request.requestId, operation: 'mutate', ok: false, error: { code: 'snapshot-conflict', message: 'Snapshot changed', retryable: false, snapshot: 'snap' } };
      }
      // timeout-unknown failure (retain record)
      if (returnTimeoutUnknown) {
        return { version: 1, requestId: request.requestId, operation: 'mutate', ok: false, error: { code: 'timeout-unknown', message: 'Operation timeout', retryable: true, snapshot: 'snap' } };
      }
      // Success case
      return { version: 1, requestId: request.requestId, operation: 'mutate', ok: true, data: { operationId: request.operationId, snapshot: 'snap', result: { state: 'completed', message: null } } };
    }
    throw new Error('unexpected request');
};

const service: GitGraphServiceClient = { request: async (request) => {
  GitGraphRequestSchema.parse(request);
  const response = await respond(request);
  GitGraphResponseSchema.parse(response);
  return response;
} };

const client = createFixtureHost({
  storage: {
    get: async () => stored,
    keys: async () => stored ? ['git-graph:op:repo'] : [],
    set: async (_key: string, value: JsonValue) => {
      if (scenario === 'storage-write-error') throw new Error('storage unavailable');
      stored = value;
    },
    delete: async () => {
      deletes += 1;
      if (deleteFailures) throw new Error('delete failed');
      stored = undefined;
    },
  },
  setHeight: async () => {},
  close: async () => {},
  writeClipboard: async () => {},
});

declare global {
  interface Window {
    commitMenuRecovery: {
      stored(): boolean;
      deletes(): number;
      settled(): number;
      mutations(): string[];
      operationQueries(): number;
      recoveryStates(): string[];
      mutationAttempts(): string[];
      requests(): Extract<GitGraphRequest, { operation: 'mutate' }>[];
    };
  }
}

function Recovery() {
  const { recovery, acknowledge } = useOperationRecovery({ host: client, service, repositoryId: 'repo', enabled: true, revision: 0, onSettled: () => { settled += 1; } });
  useEffect(() => {
    recoveryStates.push(recovery.state);
  }, [recovery.state]);
  return <div data-recovery-state={recovery.state}>{(recovery.state === 'unknown' || recovery.state === 'failed') && <button onClick={acknowledge}>Acknowledge</button>}</div>;
}

function Fixture() {
  return (
    <>
      {isRecoveryScenario ? <Recovery /> : <CommitMenuView host={client} service={service} directory="/repo" payload={{ kind: 'menu', commit, subject: 'fixture', branches: [] }} />}
    </>
  );
}

// Attach fixture API to window
window.commitMenuRecovery = {
  stored: () => stored !== undefined,
  deletes: () => deletes,
  settled: () => settled,
  mutations: () => mutations.map((request) => request.action.mutation),
  operationQueries: () => operationQueries,
  recoveryStates: () => [...recoveryStates],
  mutationAttempts: () => [...mutationAttempts],
  requests: () => [...mutations],
};

const root = document.querySelector('#root');
if (!root) throw new Error('fixture root is missing');
createRoot(root).render(<Fixture />);
