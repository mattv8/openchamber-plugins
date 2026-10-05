import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { FileTypeIcon } from './FileTypeIcon.js';
import { GraphContinuation } from './GraphContinuation.js';
import type { GitHistoryGraphNode } from '../original/gitGraph.js';

export type CommitFile = { path: string; status: string; insertions: number; deletions: number };

export function nextExpandedCommit(current: string | null, commit: string): string | null {
  return current === commit ? null : commit;
}

function pathParts(path: string): { basename: string; directory: string } {
  const separator = path.lastIndexOf('/');
  return separator === -1 ? { basename: path, directory: '' } : { basename: path.slice(separator + 1), directory: path.slice(0, separator + 1) };
}

export function CommitFiles({ commit, subject, parentIds, load, onOpenCommit, outputSwimlanes, totalColumns, t }: {
  commit: string;
  subject: string;
  parentIds: readonly string[];
  load(parent: string | null): Promise<readonly CommitFile[]>;
  onOpenCommit(): void;
  outputSwimlanes: readonly GitHistoryGraphNode[];
  totalColumns: number;
  t(key: string, values?: Record<string, string | number>): string;
}) {
  const [parent, setParent] = useState<string | null>(parentIds[0] ?? null);
  const [files, setFiles] = useState<readonly CommitFile[] | null>(null);
  const [error, setError] = useState(false);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let active = true;
    setFiles(null); setError(false);
    void loadRef.current(parent).then((next) => { if (active) setFiles(next); }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [commit, parent]);

  return <div id={`git-status-files-${commit}`} className="git-status-file-list" data-git-status-file-list={commit} role="region" aria-label={t('status.filesFor', { subject })} style={{ '--git-file-lane-count': totalColumns } as CSSProperties}>
    <GraphContinuation outputSwimlanes={outputSwimlanes} totalColumns={totalColumns} />
    {parentIds.length > 1 && <label>{t('workspace.selectParent')}<select value={parent ?? ''} onChange={(event) => setParent(event.target.value || null)}>{parentIds.map((id, index) => <option key={id} value={id}>{t('workspace.parentOption', { number: index + 1, hash: id.slice(0, 8) })}</option>)}</select></label>}
    {!files && !error && <p aria-live="polite" aria-busy="true">{t('status.filesLoading')}</p>}
    {error && <p aria-live="polite" role="alert">{t('status.filesError')}</p>}
    {files?.slice(0, 200).map((file) => {
      const { basename, directory } = pathParts(file.path);
      return <button key={file.path} type="button" className="git-status-file" data-git-file-row={file.path} aria-label={t('status.openCommitFile', { path: file.path, subject })} title={t('status.openCommitViaFile')} onClick={onOpenCommit}>
        <FileTypeIcon path={file.path} /><span className="git-file-basename">{basename}</span>{directory && <span className="git-file-dir">{directory}</span>}<span className="git-file-open-hint" aria-hidden="true"><svg viewBox="0 0 12 12"><path d="M2 1.5h5l2 2v7H2zM7 1.5v2h2" fill="none" stroke="currentColor" strokeWidth="1" /></svg></span><span className="git-file-status" data-status={file.status}>{file.status}</span>
      </button>;
    })}
    {files && files.length > 200 && <p>{t('status.filesMore', { count: files.length - 200 })}</p>}
  </div>;
}
