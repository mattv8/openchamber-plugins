import { expect, test } from 'bun:test';
import { statusControlsFor, isNotRepositoryResponse, buildMenuPayload } from '../../src/panel/components/StatusSection.js';
import { CommitMenuPayloadSchema, POPOVER_PAYLOAD_MAX } from '../../src/panel/popover/payload.js';
import { nextExpandedCommit } from '../../src/panel/components/CommitFiles.js';

test('maps graph state to host status controls', () => {
  expect(statusControlsFor('manual', true)).toEqual([
    { kind: 'select', id: 'range', label: 'Range', value: 'manual', options: [{ value: 'auto', label: 'Auto' }, { value: 'all', label: 'All' }, { value: 'manual', label: 'Manual' }] },
    { kind: 'button', id: 'refresh', label: '↻', disabled: true },
  ]);
});

test('only the not-a-repository open failure gets the neutral note', () => {
  expect(isNotRepositoryResponse({ ok: false, error: { code: 'not-a-repository' } })).toBe(true);
  expect(isNotRepositoryResponse({ ok: false, error: { code: 'internal' } })).toBe(false);
  expect(isNotRepositoryResponse({ ok: true })).toBe(false);
});

test('expanding a row is exclusive and toggles the selected row', () => {
  expect(nextExpandedCommit(null, 'a')).toBe('a');
  expect(nextExpandedCommit('a', 'a')).toBeNull();
  expect(nextExpandedCommit('a', 'b')).toBe('b');
});

test('bounds menu payloads for long commit subjects and branch names', () => {
  const sha = 'a'.repeat(40);
  const payload = buildMenuPayload({ id: sha, parentIds: [], subject: 's'.repeat(8_192), message: '', author: '', authorEmail: '', timestamp: '2026-01-01T00:00:00.000Z', statistics: { files: 0, insertions: 0, deletions: 0 }, references: Array.from({ length: 20 }, (_, index) => ({ id: `refs/heads/${index}`, name: 'b'.repeat(700), revision: sha, kind: 'local' as const, category: 'branches' as const })) });
  expect(CommitMenuPayloadSchema.safeParse(payload).success).toBe(true);
  expect(JSON.stringify(payload).length).toBeLessThanOrEqual(POPOVER_PAYLOAD_MAX);
});
