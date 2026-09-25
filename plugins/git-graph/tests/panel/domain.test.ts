import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { buildGraph, confirmMutation, mapUnifiedDiff, closeTab, emptyTabs, openTab } from '../../src/panel/domain/index.js';
import { CompactGraph } from '../../src/panel/components/CompactGraph.js';
describe('graph topology', () => test('keeps merge parents in independent lanes', () => {
  const rows = buildGraph([{ id: 'c', parentIds: ['a', 'b'], subject: 'merge', message: '', author: 'a', authorEmail: '', timestamp: '', statistics: { files: 0, insertions: 0, deletions: 0 }, references: [] }], null);
  expect(rows[0]?.output.map((lane) => lane.id)).toEqual(['a', 'b']);
}));
describe('side by side mapping', () => test('pairs context and preserves changed line coordinates', () => {
  const rows = mapUnifiedDiff('@@ -1,2 +1,2 @@\n one\n-old\n+new', [{ id: 'h1', oldStart: 1, oldLines: 2, newStart: 1, newLines: 2 }]);
  expect(rows[1]?.left?.oldLine).toBe(1); expect(rows[2]?.left?.kind).toBe('remove'); expect(rows[2]?.right?.newLine).toBe(2);
}));
test('aligns adjacent removals and additions into split rows', () => {
  const rows = mapUnifiedDiff('@@ -10,2 +10,2 @@\n-old one\n-old two\n+new one\n+new two', [{ id: 'h1', oldStart: 10, oldLines: 2, newStart: 10, newLines: 2 }]);
  expect(rows.slice(1)).toMatchObject([
    { hunkId: 'h1', left: expect.objectContaining({ kind: 'remove', oldLine: 10, text: 'old one' }), right: expect.objectContaining({ kind: 'add', newLine: 10, text: 'new one' }) },
    { hunkId: 'h1', left: expect.objectContaining({ kind: 'remove', oldLine: 11, text: 'old two' }), right: expect.objectContaining({ kind: 'add', newLine: 11, text: 'new two' }) },
  ]);
});
describe('diff tabs', () => test('selects a newly opened tab and selects previous after close', () => {
  const first = openTab(emptyTabs(), { id: 'a', title: 'a', kind: 'working', path: 'a', scope: 'unstaged', commit: null, parent: null, originalPath: null, modifiedPath: null });
  const second = openTab(first, { id: 'b', title: 'b', kind: 'working', path: 'b', scope: 'unstaged', commit: null, parent: null, originalPath: null, modifiedPath: null });
  expect(closeTab(second, 'b').activeId).toBe('a');
}));
describe('mutation confirmation', () => test('requires confirmation before destructive fallback actions', async () => {
  const intent = { title: 'Discard', message: 'Discard changes?', destructive: true, action: { mutation: 'discard-path' as const, path: 'a', scope: 'working' as const } };
  expect(await confirmMutation(undefined, intent, () => false)).toBe(false);
  expect(await confirmMutation({ confirm: async () => true }, intent, () => false)).toBe(true);
}));

test('renders compact graph lane topology for merge history', () => {
  const html = renderToStaticMarkup(createElement(CompactGraph, { commits: [{ id: 'c', parentIds: ['a', 'b'], subject: 'merge', message: '', author: 'a', authorEmail: '', timestamp: '', statistics: { files: 0, insertions: 0, deletions: 0 }, references: [] }], head: null }));
  expect(html).toContain('data-git-graph-topology');
  expect(html).toContain('<line');
});
