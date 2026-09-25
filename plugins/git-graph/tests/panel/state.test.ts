import { describe, expect, test } from 'bun:test';
import { historicalPreviewRequest, initialWorkspaceState, workspaceReducer } from '../../src/panel/state/workspace.js';
import { responseBelongsTo } from '../../src/panel/state/workspace.js';
describe('workspace failures', () => test('retains loaded data when a later request fails', () => {
  const state = { ...initialWorkspaceState(), history: [{ id: 'a' }] as never[] };
  const next = workspaceReducer(state, { type: 'error', message: 'offline' });
  expect(next.history).toEqual(state.history); expect(next.error).toBe('offline');
}));
test('rejects stale responses after repository generation changes', () => {
  expect(responseBelongsTo({ repositoryId: 'repo-a', generation: 2 }, { repositoryId: 'repo-a', generation: 2 })).toBe(true);
  expect(responseBelongsTo({ repositoryId: 'repo-a', generation: 2 }, { repositoryId: 'repo-a', generation: 1 })).toBe(false);
  expect(responseBelongsTo({ repositoryId: 'repo-a', generation: 2 }, { repositoryId: 'repo-b', generation: 2 })).toBe(false);
});

test('builds a historical preview for the selected renamed file and parent', () => {
  expect(historicalPreviewRequest({
    repositoryId: 'repo-a', snapshot: 'snapshot-a', commit: 'a'.repeat(40), parent: 'b'.repeat(40),
    file: { path: 'renamed.ts', previousPath: 'original.ts', status: 'R', insertions: 1, deletions: 1, isBinary: false }, offset: 12,
  })).toMatchObject({
    operation: 'read', read: 'commit-file-preview', repositoryId: 'repo-a', snapshot: 'snapshot-a',
    commit: 'a'.repeat(40), parent: 'b'.repeat(40), originalPath: 'original.ts', modifiedPath: 'renamed.ts', offset: 12,
  });
});

test('uses only the available side for added and deleted historical files', () => {
  const base = { repositoryId: 'repo-a', snapshot: 'snapshot-a', commit: 'a'.repeat(40), parent: null, offset: 0 };
  expect(historicalPreviewRequest({ ...base, file: { path: 'added.ts', previousPath: null, status: 'A', insertions: 1, deletions: 0, isBinary: false } })).toMatchObject({ originalPath: null, modifiedPath: 'added.ts' });
  expect(historicalPreviewRequest({ ...base, file: { path: 'deleted.ts', previousPath: null, status: 'D', insertions: 0, deletions: 1, isBinary: false } })).toMatchObject({ originalPath: 'deleted.ts', modifiedPath: null });
});

test('replaces historical files when a merge parent changes without changing open tabs', () => {
  const first = workspaceReducer(initialWorkspaceState(), {
    type: 'historical-files', commit: 'a'.repeat(40), title: 'merge', parentIds: ['b'.repeat(40), 'c'.repeat(40)], parent: 'b'.repeat(40),
    files: [{ path: 'first.ts', previousPath: null, status: 'M', insertions: 1, deletions: 0, isBinary: false }],
  });
  const next = workspaceReducer(first, {
    type: 'historical-files', commit: 'a'.repeat(40), title: 'merge', parentIds: ['b'.repeat(40), 'c'.repeat(40)], parent: 'c'.repeat(40),
    files: [{ path: 'second.ts', previousPath: null, status: 'M', insertions: 1, deletions: 0, isBinary: false }],
  });
  expect(next.historical?.parent).toBe('c'.repeat(40));
  expect(next.historical?.files.map((file) => file.path)).toEqual(['second.ts']);
  expect(next.tabs).toEqual(first.tabs);
});

test('retains loaded diffs after a later chunk request fails', () => {
  const state = workspaceReducer(initialWorkspaceState(), {
    type: 'diff', id: 'working:unstaged:a', diff: { text: 'existing diff', binary: false, truncated: false, hunks: [] },
  });
  expect(workspaceReducer(state, { type: 'error', message: 'offline' }).diffs.get('working:unstaged:a')?.text).toBe('existing diff');
});

test('keeps the selected historical commit while its files and parent change', () => {
  const selected = workspaceReducer(initialWorkspaceState(), { type: 'select-commit', commit: 'a'.repeat(40) });
  const next = workspaceReducer(selected, {
    type: 'historical-files', commit: 'a'.repeat(40), title: 'merge', parentIds: ['b'.repeat(40), 'c'.repeat(40)], parent: 'c'.repeat(40), files: [],
  });
  expect(next.selectedCommit).toBe('a'.repeat(40));
  expect(next.historical?.parent).toBe('c'.repeat(40));
});

test('clears selected commit data when another repository opens', () => {
  const selected = workspaceReducer(initialWorkspaceState(), { type: 'select-commit', commit: 'a'.repeat(40) });
  const next = workspaceReducer({ ...selected, stashes: [{ ref: 'stash@{0}', message: 'WIP', hash: 'b'.repeat(40) }] }, { type: 'opened', id: 'repo-b', snapshot: 'snapshot-b' });
  expect(next.selectedCommit).toBeNull();
  expect(next.stashes).toEqual([]);
  expect(next.historical).toBeNull();
});

test('clears only the pending operation that settled after a repository switch', () => {
  const pending = workspaceReducer(initialWorkspaceState(), { type: 'pending', id: 'operation-a', value: true });
  const switched = workspaceReducer(pending, { type: 'opened', id: 'repo-b', snapshot: 'snapshot-b' });
  expect(workspaceReducer(switched, { type: 'pending', id: 'operation-a', value: false }).pending.size).toBe(0);
});

test('keeps mutations locked after an unknown outcome until reconciliation changes the repository identity', () => {
  const unknown = workspaceReducer(initialWorkspaceState(), { type: 'mutation-unknown', id: 'operation-a' });
  expect(unknown.unknownMutation).toBe('operation-a');
  expect(workspaceReducer(unknown, { type: 'opened', id: 'repo-b', snapshot: 'snapshot-b' }).unknownMutation).toBeNull();
});
