export type HistoryMode = 'auto' | 'all' | 'manual';
export type DiffChunk = { snapshot: string; chunkId: string; offset: number; totalBytes: number; complete: boolean; text: string; isBinary: boolean; truncated: boolean };
export type CollectedDiff = { text: string; binary: boolean; truncated: boolean };

export const historyRefsForMode = (mode: HistoryMode, currentRef: string | null, manualRefs: string): string[] => {
  if (mode === 'all') return ['*'];
  if (mode === 'manual') return manualRefs.split(',').map((ref) => ref.trim()).filter(Boolean);
  return [currentRef ?? 'HEAD'];
};

const byteLength = (text: string): number => new TextEncoder().encode(text).byteLength;
const prefixWithin = (text: string, maximumBytes: number): string => {
  let output = '';
  for (const character of text) {
    if (byteLength(output + character) > maximumBytes) break;
    output += character;
  }
  return output;
};

/** Collects snapshot-pinned diff chunks without producing malformed UTF-8 text. */
export const collectDiffChunks = async (
  snapshot: string,
  loadChunk: (offset: number) => Promise<DiffChunk>,
  maximumBytes = 8 * 1024 * 1024,
): Promise<CollectedDiff> => {
  let offset = 0;
  let text = '';
  for (;;) {
    const chunk = await loadChunk(offset);
    if (chunk.snapshot !== snapshot) throw new Error('Repository changed while loading this diff');
    if (chunk.isBinary) return { text: '', binary: true, truncated: chunk.truncated };
    const remaining = maximumBytes - byteLength(text);
    const addition = prefixWithin(chunk.text, Math.max(remaining, 0));
    text += addition;
    const complete = chunk.complete && addition.length === chunk.text.length;
    if (complete) return { text, binary: false, truncated: chunk.truncated };
    if (addition.length !== chunk.text.length || byteLength(text) >= maximumBytes) return { text, binary: false, truncated: true };
    offset += byteLength(chunk.text);
  }
};
