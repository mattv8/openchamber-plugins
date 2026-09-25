import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { applyHostTheme } from '@openchamber/sdk/ui';
import '../../src/panel/styles/git-graph.css';
import { StatusSection } from '../../src/panel/components/StatusSection.js';
import type { GitGraphRequest } from '../../src/shared/protocol.js';
import type { GitGraphServiceClient, GraphCommit, GraphRef, ResolvedGitGraphResponse } from '../../src/panel/domain/index.js';

applyHostTheme({ mode: 'dark', tokens: {
  background: '#181818', elevated: '#242424', foreground: '#dddddd', muted: '#999999', subtle: '#202020', border: '#383838',
  hover: '#333333', selection: '#303030', focus: '#80b3ff', primary: '#80b3ff', mutedSurface: '#202020', elevatedForeground: '#dddddd',
  active: '#383838', selectionForeground: '#ffffff', primaryForeground: '#111111', primaryText: '#80b3ff', successText: '#75c995',
  warningText: '#e5bd72', errorText: '#f28591', infoText: '#83bedb', success: '#75c995', warning: '#e5bd72', error: '#f28591', info: '#83bedb',
  font: 'system-ui, sans-serif', mono: 'monospace', radius: '4px',
} }, document.documentElement);
document.body.dataset.surface = 'status';
document.body.style.background = 'var(--oc-bg)';

type Directory = '/fixture-a' | '/fixture-b' | '/restored' | '/retry' | null;
type Preferences = { mode: 'auto' | 'all' | 'manual'; refs: string[] };
type DelayedHistory = { request: Extract<GitGraphRequest, { operation: 'read'; read: 'history' }>; resolve(response: ResolvedGitGraphResponse): void; reject(error: Error): void };
type DelayedPreferences = { resolve(preferences: Preferences): void };

declare global { interface Window { statusSection: { requestCount(): number; rerender(): void; lastHistoryRefs(): string[]; delayHistory(directory: Exclude<Directory, null>): void; delayNextPage(): void; failNextPage(): void; pendingHistoryCount(): number; resolveDelayedHistory(): void; rejectDelayedHistory(): void; setDirectory(directory: Directory): void; setStoredPreferences(preferences: Preferences): void; deferStorageReads(): void; pendingStorageReads(): number; resolveDelayedStorageRead(): void; openedCommit(): string | null; rejectNextOpen(): void; triggerResize(): void; triggerHistoryEnd(): void; heights(): number[]; failNextStorageRead(): void; failNextStorageSave(): void; storageReads(): number; }; } }

const commitId = '0123456789abcdef0123456789abcdef01234567';
const refs: GraphRef[] = [
  { id: 'refs/heads/main', name: 'main', revision: commitId, kind: 'local', category: 'branches' },
  { id: 'refs/remotes/origin/main', name: 'origin/main', revision: commitId, kind: 'remote', category: 'remote-branches' },
];
const currentHead: GraphRef = { id: 'HEAD', name: 'main', revision: commitId, kind: 'head', category: 'branches' };
const commit = (directory: string, index = 0): GraphCommit => ({ id: index === 0 ? commitId : index.toString(16).padStart(40, '0'), parentIds: index < 100 ? [index === 0 ? '0000000000000000000000000000000000000001' : (index + 1).toString(16).padStart(40, '0')] : [], subject: index === 0 ? `Commit ${directory.slice(1)}` : `Commit ${directory.slice(1)} ${index}`, message: '', author: 'Test', authorEmail: 'test@example.invalid', timestamp: '2026-01-01T00:00:00.000Z', statistics: { files: 1, insertions: 1, deletions: 0 }, references: index === 0 ? refs : [] });
const read = (requestId: string, data: Extract<ResolvedGitGraphResponse, { operation: 'read'; ok: true }>['data']): ResolvedGitGraphResponse => ({ version: 1, requestId, operation: 'read', ok: true, data });
let updateDirectory: ((directory: Directory) => void) | null = null;
let updateRender: (() => void) | null = null;
const requests: GitGraphRequest[] = [];
let lastHistory: string[] = [];
let delayedDirectory: Exclude<Directory, null> | null = null;
let delayNextPage = false;
let failNextPage = false;
const delayed: DelayedHistory[] = [];
let storedPreferences: Preferences = { mode: 'auto', refs: [] };
let storageReadCount = 0;
let failStorageRead = false;
let deferStorageReads = false;
const delayedPreferences: DelayedPreferences[] = [];
let failStorageSave = false;
let opened: string | null = null;
let rejectOpen = false;
const reportedHeights: number[] = [];
let resizeCallback: (() => void) | null = null;
let intersectionCallback: (() => void) | null = null;
class ControlledResizeObserver implements ResizeObserver { constructor(callback: ResizeObserverCallback) { resizeCallback = () => callback([], this); } observe() {} unobserve() {} disconnect() { resizeCallback = null; } }
class ControlledIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = '0px';
  readonly thresholds = [];
  constructor(callback: IntersectionObserverCallback) {
    intersectionCallback = () => {
      // SAFETY: this fixture only needs the observed intersection boolean.
      callback([{ isIntersecting: true } as IntersectionObserverEntry], this);
    };
  }
  disconnect() { intersectionCallback = null; }
  observe() {}
  takeRecords() { return []; }
  unobserve() {}
}
window.ResizeObserver = ControlledResizeObserver;
window.IntersectionObserver = ControlledIntersectionObserver;
const host = { openCommit: async (sha: string) => { if (rejectOpen) { rejectOpen = false; throw new Error('Open diff was rejected'); } opened = sha; }, writeClipboard: async () => undefined, setHeight: async (height: number) => { reportedHeights.push(height); }, storage: { get: async () => { storageReadCount += 1; if (failStorageRead) { failStorageRead = false; throw new Error('storage unavailable'); } if (deferStorageReads) return new Promise<Preferences>((resolve) => { delayedPreferences.push({ resolve }); }); return storedPreferences; }, set: async () => { if (failStorageSave) { failStorageSave = false; throw new Error('storage unavailable'); } }, delete: async () => undefined, keys: async () => [] } };
const historyResponse = (request: Extract<GitGraphRequest, { operation: 'read'; read: 'history' }>) => read(request.requestId, { read: 'history', items: request.cursor ? [commit(request.repositoryId, 100)] : Array.from({ length: 100 }, (_, index) => commit(request.repositoryId, index)), nextCursor: request.cursor ? null : 'page-2', hasMore: !request.cursor, refsSnapshot: request.snapshot });
const service: GitGraphServiceClient = { request(request) { requests.push(request); if (request.operation === 'repo/open') return Promise.resolve({ version: 1, requestId: request.requestId, operation: 'repo/open', ok: true, data: { id: request.directory, root: request.directory, commonGitDir: `${request.directory}/.git`, head: commitId, snapshot: `${request.directory}-snapshot` } }); if (request.operation !== 'read') throw new Error(`Unexpected request ${request.operation}`); if (request.read === 'refs') return Promise.resolve(read(request.requestId, { read: 'refs', refs, current: currentHead, upstream: refs[1]!, base: null })); if (request.read === 'merge-base') return Promise.resolve(read(request.requestId, { read: 'merge-base', mergeBase: commitId })); if (request.read === 'history') { if (request.refs.length === 0) throw new Error('History requests require at least one ref'); lastHistory = request.refs; if (failNextPage && request.cursor) { failNextPage = false; return Promise.reject(new Error('page unavailable')); } if ((delayedDirectory && request.repositoryId === delayedDirectory) || (delayNextPage && request.cursor)) return new Promise((resolve, reject) => { delayed.push({ request, resolve, reject }); }); return Promise.resolve(historyResponse(request)); } throw new Error(`Unexpected read ${request.read}`); } };
window.statusSection = { requestCount: () => requests.length, rerender: () => updateRender?.(), lastHistoryRefs: () => [...lastHistory], delayHistory: (directory) => { delayedDirectory = directory; }, delayNextPage: () => { delayNextPage = true; }, failNextPage: () => { failNextPage = true; }, pendingHistoryCount: () => delayed.length, resolveDelayedHistory: () => { const pending = delayed.shift(); if (!pending) throw new Error('No delayed history request'); if (delayed.length === 0) { delayedDirectory = null; delayNextPage = false; } pending.resolve(historyResponse(pending.request)); }, rejectDelayedHistory: () => { const pending = delayed.shift(); if (!pending) throw new Error('No delayed history request'); if (delayed.length === 0) { delayedDirectory = null; delayNextPage = false; } pending.reject(new Error('page unavailable')); }, setDirectory: (directory) => updateDirectory?.(directory), setStoredPreferences: (preferences) => { storedPreferences = preferences; }, deferStorageReads: () => { deferStorageReads = true; }, pendingStorageReads: () => delayedPreferences.length, resolveDelayedStorageRead: () => { const pending = delayedPreferences.shift(); if (!pending) throw new Error('No delayed storage read'); if (delayedPreferences.length === 0) deferStorageReads = false; pending.resolve(storedPreferences); }, openedCommit: () => opened, rejectNextOpen: () => { rejectOpen = true; }, triggerResize: () => resizeCallback?.(), triggerHistoryEnd: () => intersectionCallback?.(), heights: () => [...reportedHeights], failNextStorageRead: () => { failStorageRead = true; }, failNextStorageSave: () => { failStorageSave = true; }, storageReads: () => storageReadCount };
const root = document.querySelector('#root');
if (!root) throw new Error('Fixture root is missing');
function Fixture() { const [directory, setDirectory] = useState<Directory>('/fixture-a'); const [, setRender] = useState(0); updateDirectory = setDirectory; updateRender = () => setRender((value) => value + 1); return <StatusSection directory={directory} service={service} host={host} />; }
createRoot(root).render(<Fixture />);
