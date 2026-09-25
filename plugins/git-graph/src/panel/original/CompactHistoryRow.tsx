import { GitGraphSegment } from './GitGraphSegment.js';
import { buildGitRefBadgePresentation } from './gitRefBadges.js';
import { GitRefIcon } from './GitRefIcon.js';
import type { GitHistoryGraphRef, GitHistoryItemViewModel } from './gitGraph.js';

function badgeClass(kind: 'head' | 'local' | 'remote' | 'tag', hasColor: boolean): string {
  if (hasColor) return 'git-ref-badge git-ref-badge-colored';
  return `git-ref-badge git-ref-badge-${kind}`;
}

export function CompactHistoryRow({ viewModel, onOpenCommit, t }: {
  viewModel: GitHistoryItemViewModel;
  onOpenCommit?(commit: string): void;
  t(key: string, values?: Record<string, string | number>): string;
}) {
  const { historyItem } = viewModel;
  const references: GitHistoryGraphRef[] = historyItem.references ?? [];
  const badges = buildGitRefBadgePresentation(references);
  const tagNames = references.filter((ref) => ref.kind === 'tag' && !ref.color).map((ref) => ref.name).join(', ') || undefined;
  const actionable = viewModel.kind === 'HEAD' || viewModel.kind === 'node';
  const ariaLabel = t('status.openCommit', { subject: historyItem.subject, author: historyItem.author });
  const content = <>
    <div className="git-compact-graph-segment"><GitGraphSegment viewModel={viewModel} /></div>
    <div className="git-compact-body">
    <span className={`git-compact-subject ${viewModel.kind === 'HEAD' ? 'git-compact-subject-head' : ''}`}>{historyItem.subject}</span>
    {badges.primary ? <span className="git-ref-badges" data-git-ref-badges="compact">
      <span data-git-ref-badge={badges.primary.ref.id} className={badgeClass(badges.primary.ref.kind, Boolean(badges.primary.ref.color))} style={badges.primary.ref.color ? { backgroundColor: badges.primary.ref.color } : undefined}>
        <GitRefIcon name={badges.primary.icon} className="git-ref-icon" /><span className="git-ref-badge-name">{badges.primary.ref.name}</span>
      </span>
      {badges.secondary.map((group) => { const ref = group.refs[0]; return <span key={ref.id} data-git-ref-badge-group={ref.id} className={badgeClass(ref.kind, Boolean(ref.color))} style={ref.color ? { backgroundColor: ref.color } : undefined}><GitRefIcon name={group.icon} className="git-ref-icon" />{group.refs.length > 1 ? <span aria-hidden="true">{group.refs.length}</span> : null}<span className="sr-only">{group.refs.map((item) => item.name).join(', ')}</span></span>; })}
    </span> : null}
    <span className="git-compact-author" title={historyItem.author}>{historyItem.author}</span>
    </div>
  </>;
  if (!actionable) return <div className="git-compact-history-row git-compact-history-row-static" data-git-graph-status-commit={historyItem.id}>{content}</div>;
  return <button type="button" className="git-compact-history-row" data-git-graph-status-commit={historyItem.id} aria-label={ariaLabel} title={tagNames} onClick={() => onOpenCommit?.(historyItem.id)}>{content}</button>;
}
