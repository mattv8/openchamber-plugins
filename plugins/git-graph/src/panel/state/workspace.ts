import type { DiffTab, TabState } from '../domain/tabs.js';
import type { ResolvedGitGraphResponse } from '../domain/index.js';
import type { GitGraphRequest } from '../../shared/protocol.js';
import { emptyTabs, openTab } from '../domain/tabs.js';

export type HistoricalFile = { path: string; previousPath: string | null; status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T'; insertions: number; deletions: number; isBinary: boolean };
export type HistoricalSelection = { commit: string; title: string; parentIds: readonly string[]; parent: string | null; files: readonly HistoricalFile[] };
export type WorkspaceDiff = { text: string; binary: boolean; truncated: boolean; hunks: readonly { id: string; oldStart: number; oldLines: number; newStart: number; newLines: number }[] };
export type WorkspaceState = { repositoryId: string | null; snapshot: string | null; attention: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null; history: readonly import('../domain/graph.js').GraphCommit[]; refs: readonly import('../domain/graph.js').GraphRef[]; current: import('../domain/graph.js').GraphRef | null; files: readonly { path: string; index: string; workingDirectory: string; staged: boolean; unstaged: boolean }[]; stashes: readonly { ref: string; message: string; hash: string }[]; selectedCommit: string | null; historical: HistoricalSelection | null; tabs: TabState; diffs: ReadonlyMap<string, WorkspaceDiff>; error: string | null; loading: boolean; hasMore: boolean; cursor: string | null; pending: ReadonlySet<string>; unknownMutation: string | null };
export const initialWorkspaceState = (): WorkspaceState => ({ repositoryId: null, snapshot: null, attention: null, history: [], refs: [], current: null, files: [], stashes: [], selectedCommit: null, historical: null, tabs: emptyTabs(), diffs: new Map(), error: null, loading: false, hasMore: false, cursor: null, pending: new Set(), unknownMutation: null });
export function responseBelongsTo(current: { repositoryId: string | null; generation: number }, response: { repositoryId: string; generation: number }): boolean {
  return current.repositoryId === response.repositoryId && current.generation === response.generation;
}
export type WorkspaceAction = { type: 'loading'; value: boolean } | { type: 'opened'; id: string; snapshot: string } | { type: 'read'; data: Extract<ResolvedGitGraphResponse, { operation: 'read'; ok: true }>['data']; append?: boolean } | { type: 'error'; message: string } | { type: 'tab'; tab: DiffTab } | { type: 'close-tab'; id: string } | { type: 'pending'; id: string; value: boolean } | { type: 'mutation-unknown'; id: string | null } | { type: 'select-commit'; commit: string | null } | { type: 'historical-files'; commit: string; title: string; parentIds: readonly string[]; parent: string | null; files: readonly HistoricalFile[] } | { type: 'diff'; id: string; diff: WorkspaceDiff };

export function historicalPreviewRequest({ repositoryId, snapshot, commit, parent, file, offset, requestId = 'historical-preview' }: { repositoryId: string; snapshot: string; commit: string; parent: string | null; file: HistoricalFile; offset: number; requestId?: string }): Extract<GitGraphRequest, { operation: 'read'; read: 'commit-file-preview' }> {
  const originalPath = file.status === 'A' ? null : file.previousPath ?? file.path;
  const modifiedPath = file.status === 'D' ? null : file.path;
  return { version: 1, requestId, repositoryId, snapshot, operation: 'read', read: 'commit-file-preview', commit, parent, originalPath, modifiedPath, offset, limit: 240000 };
}
export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  if (action.type === 'loading') return { ...state, loading: action.value };
  if (action.type === 'opened') return action.id === state.repositoryId
    ? { ...state, snapshot: action.snapshot, error: null }
    : { ...state, repositoryId: action.id, snapshot: action.snapshot, attention: null, files: [], stashes: [], selectedCommit: null, historical: null, tabs: emptyTabs(), diffs: new Map(), error: null, hasMore: false, cursor: null, pending: new Set(), unknownMutation: null };
  if (action.type === 'error') return { ...state, error: action.message, loading: false };
  if (action.type === 'tab') return { ...state, tabs: openTab(state.tabs, action.tab) };
  if (action.type === 'close-tab') { const tabs = state.tabs.tabs.filter((tab) => tab.id !== action.id); return { ...state, tabs: { tabs, activeId: state.tabs.activeId === action.id ? (tabs.at(-1)?.id ?? null) : state.tabs.activeId } }; }
  if (action.type === 'pending') { const pending = new Set(state.pending); if (action.value) pending.add(action.id); else pending.delete(action.id); return { ...state, pending }; }
  if (action.type === 'mutation-unknown') return { ...state, unknownMutation: action.id };
  if (action.type === 'select-commit') return { ...state, selectedCommit: action.commit };
  if (action.type === 'historical-files') return { ...state, historical: { commit: action.commit, title: action.title, parentIds: action.parentIds, parent: action.parent, files: action.files }, error: null };
  if (action.type === 'diff') return { ...state, diffs: new Map(state.diffs).set(action.id, action.diff) };
  switch (action.data.read) {
    case 'status': return { ...state, attention: action.data.status.attention, files: action.data.status.files, error: null };
    case 'working-tree': return { ...state, attention: action.data.status.attention, files: action.data.status.files, stashes: action.data.stashes, error: null };
    case 'history': return { ...state, history: action.append ? [...state.history, ...action.data.items] : action.data.items, cursor: action.data.nextCursor, hasMore: action.data.hasMore, error: null };
    case 'refs': return { ...state, refs: action.data.refs, current: action.data.current, error: null };
    default: return state;
  }
}
