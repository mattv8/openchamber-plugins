import { buildGraph, type GraphCommit, type GraphRef, type Translate } from '../domain/index.js';
import { GraphSvg } from './GraphSvg.js';
import { defaultT } from '../i18n/index.js';
export function CompactGraph({ commits, head, onSelect, state = 'ready', t = defaultT }: { commits: readonly GraphCommit[]; head: GraphRef | null; onSelect?(commit: GraphCommit): void; state?: 'loading' | 'empty' | 'error' | 'ready'; t?: Translate }) {
  if (state === 'loading') return <section className="git-compact-graph" data-git-graph-compact="true" aria-busy="true">{t('compact.loading')}</section>;
  if (state === 'error') return <section className="git-compact-graph" data-git-graph-compact="true" role="alert">{t('compact.error')}</section>;
  if (state === 'empty' || commits.length === 0) return <section className="git-compact-graph" data-git-graph-compact="true">{t('compact.empty')}</section>;
  return <section className="git-compact-graph" data-git-graph-compact="true">{buildGraph(commits.slice(0, 12), head).map((row) => <button key={row.commit.id} onClick={() => onSelect?.(row.commit)}><GraphSvg row={row} /><span>{row.commit.subject}</span></button>)}</section>;
}
