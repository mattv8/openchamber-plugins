import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { Workspace } from '../../src/panel/components/Workspace.js';
import type { GitGraphRequest } from '../../src/shared/protocol.js';
import type { GitGraphServiceClient, ResolvedGitGraphResponse } from '../../src/panel/domain/index.js';

type DeferredMutation = { request: Extract<GitGraphRequest, { operation: 'mutate' }>; resolve(response: ResolvedGitGraphResponse): void };

declare global {
  interface Window {
    mutationGuard: {
    mutationCount(): number;
    mutationRepositoryId(index: number): string | null;
    latestReadRepositoryId(): string | null;
    refreshCount(): number;
    deferNextOpen(): void;
    pendingOpenCount(): number;
    resolveOpen(): void;
    timeoutFirst(): void;
    timeoutMutation(index: number): void;
    completeMutation(index: number): void;
    switchDirectory(directory: '/fixture-a' | '/fixture-b'): void;
    };
  }
}

const status = {
  current: 'main', tracking: null, ahead: 0, behind: 0, isClean: false,
  files: [{ path: 'file.ts', index: ' ', workingDirectory: 'M', staged: false, unstaged: true }], attention: null,
};
const read = (requestId: string, data: Extract<ResolvedGitGraphResponse, { operation: 'read'; ok: true }>['data']): ResolvedGitGraphResponse => ({ version: 1, requestId, operation: 'read', ok: true, data });
const mutations: Extract<GitGraphRequest, { operation: 'mutate' }>[] = [];
let refreshes = 0;
let latestReadRepositoryId: string | null = null;
let deferOpen = false;
const deferredOpens: { response: ResolvedGitGraphResponse; resolve(response: ResolvedGitGraphResponse): void }[] = [];
const deferredMutations: DeferredMutation[] = [];
let setDirectory: ((directory: '/fixture-a' | '/fixture-b') => void) | null = null;

const service: GitGraphServiceClient = {
  request(request) {
    if (request.operation === 'repo/open') {
      const repositoryId = request.directory === '/fixture-b' ? 'repo-b' : 'repo-a';
      const response: ResolvedGitGraphResponse = { version: 1, requestId: request.requestId, operation: 'repo/open', ok: true, data: { id: repositoryId, root: request.directory, commonGitDir: `${request.directory}/.git`, head: null, snapshot: `${repositoryId}-snapshot` } };
      if (!deferOpen) return Promise.resolve(response);
      deferOpen = false;
      return new Promise((resolve) => { deferredOpens.push({ response, resolve }); });
    }
    if (request.operation === 'refresh') { refreshes += 1; return Promise.resolve({ version: 1, requestId: request.requestId, operation: 'refresh', ok: true, data: { snapshot: request.snapshot, changed: false } }); }
    if (request.operation === 'mutate') {
      mutations.push(request);
      return new Promise((resolve) => { deferredMutations.push({ request, resolve }); });
    }
    if (request.operation !== 'read') throw new Error('unexpected request');
    latestReadRepositoryId = request.repositoryId;
    if (request.read === 'working-tree') return Promise.resolve(read(request.requestId, { read: 'working-tree', status, stashes: [] }));
    if (request.read === 'refs') return Promise.resolve(read(request.requestId, { read: 'refs', refs: [], current: null, upstream: null, base: null }));
    if (request.read === 'history') return Promise.resolve(read(request.requestId, { read: 'history', items: [], nextCursor: null, hasMore: false, refsSnapshot: request.snapshot }));
    if (request.read === 'hunks') return Promise.resolve(read(request.requestId, { read: 'hunks', snapshot: request.snapshot, hunks: [{ id: 'hunk-1', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }] }));
    if (request.read === 'working-tree-diff') return Promise.resolve(read(request.requestId, { read: 'working-tree-diff', chunk: { snapshot: request.snapshot, chunkId: 'chunk-1', offset: 0, totalBytes: 20, complete: true, text: '@@ -1 +1 @@\n-old\n+new', isBinary: false, truncated: false } }));
    throw new Error(`unexpected read ${request.read}`);
  },
};

window.mutationGuard = {
  mutationCount: () => mutations.length,
  mutationRepositoryId: (index) => mutations[index]?.repositoryId ?? null,
  latestReadRepositoryId: () => latestReadRepositoryId,
  refreshCount: () => refreshes,
  deferNextOpen: () => { deferOpen = true; },
  pendingOpenCount: () => deferredOpens.length,
  resolveOpen: () => {
    const deferred = deferredOpens.shift();
    if (!deferred) throw new Error('no repository open is pending');
    deferred.resolve(deferred.response);
  },
  timeoutFirst: () => window.mutationGuard.timeoutMutation(0),
  timeoutMutation: (index) => {
    const deferred = deferredMutations[index];
    if (!deferred) throw new Error(`mutation ${index} was not started`);
    deferred.resolve({ version: 1, requestId: deferred.request.requestId, operation: 'mutate', ok: false, error: { code: 'timeout-unknown', message: 'timed out', retryable: true, snapshot: deferred.request.snapshot } });
  },
  completeMutation: (index) => {
    const deferred = deferredMutations[index];
    if (!deferred) throw new Error(`mutation ${index} was not started`);
    deferred.resolve({ version: 1, requestId: deferred.request.requestId, operation: 'mutate', ok: true, data: { operationId: deferred.request.operationId, snapshot: deferred.request.snapshot, result: { state: 'completed', message: null } } });
  },
  switchDirectory: (directory) => {
    if (!setDirectory) throw new Error('fixture is not mounted');
    setDirectory(directory);
  },
};

const root = document.querySelector('#root');
if (!root) throw new Error('fixture root is missing');
function Fixture() {
  const [directory, updateDirectory] = useState<'/fixture-a' | '/fixture-b'>('/fixture-a');
  setDirectory = updateDirectory;
  return <Workspace directory={directory} service={service} pollIntervalMs={60_000} />;
}

createRoot(root).render(<Fixture />);
