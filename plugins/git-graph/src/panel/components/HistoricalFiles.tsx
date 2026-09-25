import type { Translate } from '../domain/index.js';
import type { HistoricalFile, HistoricalSelection } from '../state/workspace.js';

export function HistoricalFiles({ selection, t, onParentChange, onOpenFile }: { selection: HistoricalSelection | null; t: Translate; onParentChange(parent: string): void; onOpenFile(file: HistoricalFile): void }) {
  if (!selection) return null;
  return <section className="git-historical-files" data-git-graph-historical-files="true">
    <h2>{t('workspace.files')}</h2>
    {selection.parentIds.length === 0
      ? <p>{t('workspace.rootCommit')}</p>
      : selection.parentIds.length > 1
        ? <label>{t('workspace.parent')}<select aria-label={t('workspace.selectParent')} value={selection.parent ?? ''} onChange={(event) => onParentChange(event.target.value)}>{selection.parentIds.map((parent, index) => <option key={parent} value={parent}>{t('workspace.parentOption', { number: index + 1, hash: parent.slice(0, 8) })}</option>)}</select></label>
        : <p>{t('workspace.parent')}: {selection.parent?.slice(0, 8)}</p>}
    {selection.files.map((file) => <button key={`${file.previousPath ?? ''}:${file.path}`} type="button" onClick={() => onOpenFile(file)}>{file.path}</button>)}
  </section>;
}
