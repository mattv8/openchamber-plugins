import { useEffect, useRef, useState } from 'react';

export type CommitFile = { path: string; status: string; insertions: number; deletions: number };

export function nextExpandedCommit(current: string | null, commit: string): string | null {
  return current === commit ? null : commit;
}

export function CommitFiles({ commit, subject, parentIds, load, onOpenCommit, t }: {
  commit: string;
  subject: string;
  parentIds: readonly string[];
  load(parent: string | null): Promise<readonly CommitFile[]>;
  onOpenCommit(): void;
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

  return <div id={`git-status-files-${commit}`} className="git-status-file-list" data-git-status-file-list={commit} role="region" aria-label={t('status.filesFor', { subject })}>
    {parentIds.length > 1 && <label>{t('workspace.selectParent')}<select value={parent ?? ''} onChange={(event) => setParent(event.target.value || null)}>{parentIds.map((id, index) => <option key={id} value={id}>{t('workspace.parentOption', { number: index + 1, hash: id.slice(0, 8) })}</option>)}</select></label>}
    {!files && !error && <p aria-live="polite" aria-busy="true">{t('status.filesLoading')}</p>}
    {error && <p aria-live="polite" role="alert">{t('status.filesError')}</p>}
    {files?.slice(0, 200).map((file) => <button key={file.path} type="button" className="git-status-file" aria-label={t('status.openCommitFile', { path: file.path, subject })} title={t('status.openCommitViaFile')} onClick={onOpenCommit}><span>{file.status}</span><span>{file.path}</span>{file.insertions ? <span className="git-status-file-add">+{file.insertions}</span> : null}{file.deletions ? <span className="git-status-file-delete">−{file.deletions}</span> : null}</button>)}
    {files && files.length > 200 && <p>{t('status.filesMore', { count: files.length - 200 })}</p>}
  </div>;
}
