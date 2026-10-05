import { GitGraphSegment } from './GitGraphSegment.js';
import type React from 'react';
import { buildGitRefBadgePresentation } from './gitRefBadges.js';
import { GitRefIcon } from './GitRefIcon.js';
import type { GitHistoryGraphRef, GitHistoryItemViewModel } from './gitGraph.js';

function badgeClass(kind: 'head' | 'local' | 'remote' | 'tag', hasColor: boolean): string {
  if (hasColor) return 'git-ref-badge git-ref-badge-colored';
  return `git-ref-badge git-ref-badge-${kind}`;
}

export function CompactHistoryRow({ viewModel, expanded = false, onToggle, hoverAnchor, menuTrigger, t }: {
  viewModel: GitHistoryItemViewModel;
  expanded?: boolean;
  onToggle?(commit: string): void;
  hoverAnchor?(element: HTMLElement | null): void;
  menuTrigger?: { onContextMenu(event: React.MouseEvent<HTMLElement>): void; onKeyDown(event: React.KeyboardEvent<HTMLElement>): void };
  t(key: string, values?: Record<string, string | number>): string;
}) {
  const { historyItem } = viewModel;
  const references: GitHistoryGraphRef[] = historyItem.references ?? [];
  const badges = buildGitRefBadgePresentation(references);
  const tagNames = references.filter((ref) => ref.kind === 'tag' && !ref.color).map((ref) => ref.name).join(', ') || undefined;
  const accessibleTagNames = references.filter((ref) => ref.kind === 'tag').map((ref) => ref.name).join(', ');
  const actionable = viewModel.kind === 'HEAD' || viewModel.kind === 'node';
  const ariaLabel = accessibleTagNames
    ? t('status.toggleCommitFilesWithTags', { subject: historyItem.subject, author: historyItem.author, tags: accessibleTagNames })
    : t('status.toggleCommitFiles', { subject: historyItem.subject, author: historyItem.author });
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
  return <button ref={hoverAnchor} type="button" className="git-compact-history-row" data-git-graph-status-commit={historyItem.id} aria-label={ariaLabel} title={tagNames} aria-expanded={expanded} aria-controls={`git-status-files-${historyItem.id}`} onClick={() => onToggle?.(historyItem.id)} onContextMenu={menuTrigger?.onContextMenu} onKeyDown={menuTrigger?.onKeyDown}>{content}</button>;
}
