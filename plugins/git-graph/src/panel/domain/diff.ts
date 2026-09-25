export type DiffLine = { kind: 'context' | 'add' | 'remove' | 'meta'; text: string; oldLine: number | null; newLine: number | null; hunkId: string | null };
export type DiffRow = { key: string; left: DiffLine | null; right: DiffLine | null; hunkId: string | null };

/** Maps a unified Git diff into stable, worker-free side-by-side rows. */
export function mapUnifiedDiff(text: string, hunks: readonly { id: string; oldStart: number; oldLines: number; newStart: number; newLines: number }[] = []): DiffRow[] {
  const rows: DiffRow[] = [];
  const lineKey = (hunkId: string | null, left: DiffLine | null, right: DiffLine | null) => `${hunkId ?? 'meta'}:${left?.kind ?? 'none'}:${left?.oldLine ?? 'none'}:${right?.kind ?? 'none'}:${right?.newLine ?? 'none'}:${left?.text ?? right?.text ?? ''}`;
  const append = (left: DiffLine | null, right: DiffLine | null, hunkId: string | null) => rows.push({ key: lineKey(hunkId, left, right), left, right, hunkId });
  let oldLine = 0;
  let newLine = 0;
  let hunkIndex = -1;
  const rawLines = text.split('\n');
  for (let source = 0; source < rawLines.length; source += 1) {
    const raw = rawLines[source] ?? '';
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (header) {
      oldLine = Number(header[1]); newLine = Number(header[2]); hunkIndex += 1;
      const hunkId = hunks[hunkIndex]?.id ?? null;
      append({ kind: 'meta', text: raw, oldLine: null, newLine: null, hunkId }, null, hunkId);
      continue;
    }
    const hunkId = hunks[hunkIndex]?.id ?? null;
    if (raw.startsWith('---') || raw.startsWith('+++') || raw.startsWith('diff ') || raw.startsWith('index ')) {
      append({ kind: 'meta', text: raw, oldLine: null, newLine: null, hunkId }, null, hunkId); continue;
    }
    if (raw.startsWith('-')) {
      const removals: DiffLine[] = [];
      while ((rawLines[source] ?? '').startsWith('-')) {
        const removal = rawLines[source] ?? '';
        removals.push({ kind: 'remove', text: removal.slice(1), oldLine: oldLine++, newLine: null, hunkId });
        source += 1;
      }
      const additions: DiffLine[] = [];
      while ((rawLines[source] ?? '').startsWith('+')) {
        const addition = rawLines[source] ?? '';
        additions.push({ kind: 'add', text: addition.slice(1), oldLine: null, newLine: newLine++, hunkId });
        source += 1;
      }
      source -= 1;
      const pairCount = Math.max(removals.length, additions.length);
      for (let pair = 0; pair < pairCount; pair += 1) append(removals[pair] ?? null, additions[pair] ?? null, hunkId);
      continue;
    }
    if (raw.startsWith('+')) { append(null, { kind: 'add', text: raw.slice(1), oldLine: null, newLine: newLine++, hunkId }, hunkId); continue; }
    const line: DiffLine = { kind: 'context', text: raw.startsWith(' ') ? raw.slice(1) : raw, oldLine: oldLine++, newLine: newLine++, hunkId };
    append(line, { ...line }, hunkId);
  }
  return rows;
}
