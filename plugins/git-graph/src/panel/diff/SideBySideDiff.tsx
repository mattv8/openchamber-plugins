import type { ReactNode } from 'react';
import { mapUnifiedDiff } from '../domain/diff.js';

type Props = { text: string; hunks?: readonly { id: string; oldStart: number; oldLines: number; newStart: number; newLines: number }[]; isBinary: boolean; truncated: boolean; disabled?: boolean; onHunkAction?(hunkId: string, action: 'stage-hunk' | 'unstage-hunk' | 'discard-hunk'): void; labels: { binary: string; truncated: string; stage: string; unstage: string; discard: string } };
const cell = (line: { kind: string; text: string; oldLine: number | null; newLine: number | null } | null, side: 'left' | 'right'): ReactNode => line && <><span className="git-diff-number">{side === 'left' ? line.oldLine : line.newLine}</span><code className={`git-diff-${line.kind}`}>{line.text}</code></>;
export function SideBySideDiff({ text, hunks = [], isBinary, truncated, disabled = false, onHunkAction, labels }: Props) {
  if (isBinary) return <p className="git-diff-notice">{labels.binary}</p>;
  return <section className="git-diff" data-git-graph-diff="side-by-side">
    {truncated && <p className="git-diff-notice">{labels.truncated}</p>}
    {mapUnifiedDiff(text, hunks).map((row) => <div className="git-diff-row" key={row.key}>
      <div className="git-diff-cell">{cell(row.left, 'left')}</div><div className="git-diff-cell">{cell(row.right, 'right')}</div>
      {row.hunkId && onHunkAction && <div className="git-hunk-actions"><button disabled={disabled} onClick={() => onHunkAction(row.hunkId!, 'stage-hunk')}>{labels.stage}</button><button disabled={disabled} onClick={() => onHunkAction(row.hunkId!, 'unstage-hunk')}>{labels.unstage}</button><button disabled={disabled} onClick={() => onHunkAction(row.hunkId!, 'discard-hunk')}>{labels.discard}</button></div>}
    </div>)}
  </section>;
}
