import { describe, expect, test } from 'bun:test';
import { collectDiffChunks, historyRefsForMode, type DiffChunk } from '../../src/panel/domain/index.js';

describe('history reference controls', () => {
  test('uses the checked out ref for automatic history', () => {
    expect(historyRefsForMode('auto', 'refs/heads/main', '')).toEqual(['refs/heads/main']);
  });
  test('uses the service all-refs sentinel', () => {
    expect(historyRefsForMode('all', 'refs/heads/main', '')).toEqual(['*']);
  });
  test('uses trimmed manual refs and rejects an empty selection', () => {
    expect(historyRefsForMode('manual', null, ' refs/heads/main, v1 ')).toEqual(['refs/heads/main', 'v1']);
    expect(historyRefsForMode('manual', null, ' , ')).toEqual([]);
  });
});

describe('diff chunk collection', () => {
  const chunk = (offset: number, text: string, complete: boolean): DiffChunk => ({ snapshot: 'snapshot-1', chunkId: `chunk-${offset}`, offset, totalBytes: 6, complete, text, isBinary: false, truncated: false });
  test('uses UTF-8 byte offsets while collecting a complete diff', async () => {
    const offsets: number[] = [];
    const result = await collectDiffChunks('snapshot-1', async (offset) => { offsets.push(offset); return offset === 0 ? chunk(0, 'é', false) : chunk(2, 'text', true); });
    expect(offsets).toEqual([0, 2]);
    expect(result).toMatchObject({ text: 'étext', truncated: false, binary: false });
  });
  test('stops at binary content without requesting another chunk', async () => {
    let calls = 0;
    const result = await collectDiffChunks('snapshot-1', async () => { calls += 1; return { ...chunk(0, '', false), isBinary: true }; });
    expect(calls).toBe(1);
    expect(result.binary).toBe(true);
  });
  test('rejects chunks from a changed repository snapshot', async () => {
    await expect(collectDiffChunks('snapshot-1', async () => ({ ...chunk(0, 'text', true), snapshot: 'snapshot-2' }))).rejects.toThrow('changed while loading');
  });
});
