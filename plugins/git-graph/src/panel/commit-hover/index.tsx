import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { HostClient } from '@openchamber/sdk';
import { mountPopoverAnchor } from '@openchamber/sdk/ui';
import type { GitGraphServiceClient, GraphCommit } from '../domain/index.js';
import type { CommitHoverPayload } from '../popover/payload.js';
import type { GitGraphResponse } from '../../shared/protocol.js';
import type { GitHistoryGraphRef } from '../original/gitGraph.js';
import { GitRefIcon } from '../original/GitRefIcon.js';
import { buildGitRefBadgePresentation } from '../original/gitRefBadges.js';
import { defaultT } from '../i18n/index.js';
import { isMenuOpen } from '../popover/menu-state.js';
import { createCommitSummaryCache } from './cache.js';
import { buildHoverPayload, commitBody, initials, relativeTime } from './model.js';
import { githubRepositoryUrl } from './remote.js';

export type HoverRepository = { directory: string; repositoryId: string; snapshot: string };

type Summary = NonNullable<CommitHoverPayload['summary']>;
type CommitAuthor = NonNullable<Extract<Extract<GitGraphResponse, { ok: true; operation: 'read' }>['data'], { read: 'commit-author' }>['author']>;
type HoverState = { host: HostClient; service: GitGraphServiceClient; repository: HoverRepository; cache: ReturnType<typeof createCommitSummaryCache<Summary>>; remoteUrl: string | null };
const HoverContext = createContext<HoverState | null>(null);

const summaryFrom = (response: Awaited<ReturnType<GitGraphServiceClient['request']>>): Summary | null => (
  response.ok && response.operation === 'read' && response.data.read === 'commit-summary'
    ? { message: response.data.commit.message, messageTruncated: response.data.messageTruncated, statistics: response.data.commit.statistics }
    : null
);

/** Owns remote lookup, the summary cache and hover enablement for one status frame. */
export function CommitHoverProvider(props: { host: HostClient; service: GitGraphServiceClient; repository: HoverRepository | null; enabled: boolean; children: ReactNode }): ReactNode {
  const [remoteUrl, setRemoteUrl] = useState<string | null>(null);
  const serviceRef = useRef(props.service);
  serviceRef.current = props.service;
  const directory = props.repository?.directory ?? null;
  const repositoryId = props.repository?.repositoryId ?? null;
  const snapshot = props.repository?.snapshot ?? null;
  const repositoryKey = directory && repositoryId && snapshot ? `${directory}:${repositoryId}:${snapshot}` : null;
  const repository = useMemo<HoverRepository | null>(() => directory && repositoryId && snapshot ? { directory, repositoryId, snapshot } : null, [directory, repositoryId, snapshot]);
  const cache = useMemo(() => repository && props.enabled ? createCommitSummaryCache<Summary>({
    load: async (commit) => {
      const response = await serviceRef.current.request({ version: 1, requestId: `hover-summary:${crypto.randomUUID()}`, operation: 'read', read: 'commit-summary', repositoryId: repository.repositoryId, snapshot: repository.snapshot, commit });
      const summary = summaryFrom(response);
      if (!summary) throw new Error('Commit summary was unavailable');
      return summary;
    },
  }) : null, [props.enabled, repositoryKey]);
  useEffect(() => {
    setRemoteUrl(null);
    if (!repository || !props.enabled) return;
    let active = true;
    void serviceRef.current.request({ version: 1, requestId: `hover-remotes:${crypto.randomUUID()}`, operation: 'read', read: 'remotes', repositoryId: repository.repositoryId, snapshot: repository.snapshot }).then((response) => {
      if (active && response.ok && response.operation === 'read' && response.data.read === 'remotes') setRemoteUrl(githubRepositoryUrl(response.data.remotes));
    }).catch(() => undefined);
    return () => { active = false; };
  }, [props.enabled, directory, repositoryId, snapshot]);
  const state = useMemo<HoverState | null>(() => props.enabled && repository && cache ? { host: props.host, service: props.service, repository, cache, remoteUrl } : null, [props.enabled, props.host, props.service, repositoryKey, cache, remoteUrl]);
  return <HoverContext.Provider value={state}>{props.children}</HoverContext.Provider>;
}

/** Ref callback for a commit row element. No-op when popovers are unsupported or disabled. */
export function useCommitHoverAnchor(commit: GraphCommit, refs: readonly GitHistoryGraphRef[]): (element: HTMLElement | null) => void {
  const state = useContext(HoverContext);
  const cleanup = useRef<(() => void) | null>(null);
  const stateRef = useRef(state);
  const commitRef = useRef(commit);
  const refsRef = useRef(refs);
  stateRef.current = state;
  commitRef.current = commit;
  refsRef.current = refs;
  useEffect(() => () => cleanup.current?.(), []);
  return useCallback((element) => {
    cleanup.current?.(); cleanup.current = null;
    const current = stateRef.current;
    if (!element || !current) return;
    let preloadTimer: number | null = null;
    const key = () => commitRef.current.id;
    const preload = () => { if (isMenuOpen()) return; preloadTimer = window.setTimeout(() => { preloadTimer = null; if (!isMenuOpen()) void stateRef.current?.cache.preload(key()); }, 75); };
    const cancel = () => { if (preloadTimer !== null) window.clearTimeout(preloadTimer); preloadTimer = null; };
    const anchor = mountPopoverAnchor(element, { host: current.host, width: 340, height: 220, side: 'left', getData: () => {
      if (isMenuOpen()) throw new Error('Menu is open');
      const active = stateRef.current!;
      const currentCommit = commitRef.current;
      const snapshot = active.cache.get(key());
      const summary = snapshot.status === 'ready' ? snapshot.value : null;
      const remote = active.remoteUrl ? `${active.remoteUrl}/commit/${currentCommit.id}` : null;
      return buildHoverPayload(currentCommit, refsRef.current, remote, summary);
    } });
    element.addEventListener('pointerenter', preload);
    element.addEventListener('pointerleave', cancel);
    cleanup.current = () => { cancel(); element.removeEventListener('pointerenter', preload); element.removeEventListener('pointerleave', cancel); anchor.dispose(); };
  }, [Boolean(state)]);
}

/** Child-frame card for kind:'hover'. */
const canonicalAvatarUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.origin === 'https://avatars.githubusercontent.com' && /^\/u\/\d+$/.test(url.pathname) && !url.username && !url.password && !url.hash;
  } catch { return false; }
};

function CommitHoverAvatar(props: { author: string; github: CommitAuthor | null }) {
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const avatarUrl = props.github?.avatarUrl ?? null;
  useEffect(() => {
    setLoadedUrl(null);
    if (!avatarUrl || !canonicalAvatarUrl(avatarUrl)) return;
    let active = true;
    const image = new Image();
    const cleanup = () => { window.clearTimeout(timeout); image.onload = null; image.onerror = null; };
    const timeout = window.setTimeout(() => { cleanup(); }, 5_000);
    image.onload = () => { cleanup(); if (active) setLoadedUrl(avatarUrl); };
    image.onerror = cleanup;
    image.referrerPolicy = 'no-referrer';
    image.src = avatarUrl;
    return () => { active = false; cleanup(); };
  }, [avatarUrl]);
  return <span className="git-commit-hover-avatar" data-git-commit-hover-avatar>{loadedUrl === avatarUrl && avatarUrl ? <img className="git-commit-hover-avatar-img" src={avatarUrl} alt="" aria-hidden="true" referrerPolicy="no-referrer" onError={() => setLoadedUrl(null)} /> : <span className="git-commit-hover-initials" aria-hidden="true">{initials(props.author)}</span>}</span>;
}

function CommitHoverCardContent(props: { host: HostClient; service: GitGraphServiceClient; directory: string; payload: CommitHoverPayload }): ReactNode {
  const { host, service, directory, payload } = props;
  const [summary, setSummary] = useState<Summary | null>(payload.summary);
  const [loading, setLoading] = useState(payload.summary === null);
  const [error, setError] = useState<string | null>(null);
  const [githubAuthor, setGithubAuthor] = useState<CommitAuthor | null>(null);
  const [copied, setCopied] = useState(false);
  const card = useRef<HTMLElement | null>(null);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const opened = await service.request({ version: 1, requestId: `hover-open:${crypto.randomUUID()}`, repositoryId: 'popover', operation: 'repo/open', directory });
        if (!opened.ok || opened.operation !== 'repo/open') throw new Error('open');
        void service.request({ version: 1, requestId: `hover-author:${crypto.randomUUID()}`, operation: 'read', read: 'commit-author', repositoryId: opened.data.id, snapshot: opened.data.snapshot, commit: payload.commit }).then((response) => {
          if (active && response.ok && response.operation === 'read' && response.data.read === 'commit-author') setGithubAuthor(response.data.author);
        }).catch(() => undefined);
        if (payload.summary) return;
        const response = await service.request({ version: 1, requestId: `hover-card:${crypto.randomUUID()}`, operation: 'read', read: 'commit-summary', repositoryId: opened.data.id, snapshot: opened.data.snapshot, commit: payload.commit });
        const next = summaryFrom(response);
        if (!next) throw new Error(response.ok ? 'summary' : response.error.code);
        if (active) setSummary(next);
      } catch (cause) { if (active && !payload.summary) setError(cause instanceof Error && cause.message === 'not-found' ? defaultT('hover.notFound') : defaultT('hover.serviceError')); }
      finally { if (active && !payload.summary) setLoading(false); }
    })();
    return () => { active = false; };
  }, [directory, payload, service]);
  useEffect(() => {
    if (!card.current || !globalThis.ResizeObserver) return;
    const observer = new ResizeObserver(() => { if (card.current) void host.setHeight(Math.ceil(card.current.getBoundingClientRect().height)); });
    observer.observe(card.current); return () => observer.disconnect();
  }, [host]);
  const message = summary?.message ?? '';
  const refs = payload.refs.map((ref) => ({ ...ref, revision: null, category: ref.kind === 'tag' ? 'tags' : ref.kind === 'remote' ? 'remote-branches' : 'branches' } as GitHistoryGraphRef));
  const presentation = buildGitRefBadgePresentation(refs);
  const badge = (ref: GitHistoryGraphRef) => <span key={ref.id} data-git-commit-hover-ref={ref.id} className={`git-ref-badge ${ref.color ? 'git-ref-badge-colored' : ''} ${ref.kind === 'tag' ? 'git-ref-badge-tag' : ''}`} style={ref.color ? { backgroundColor: ref.color } : undefined}><GitRefIcon name={ref.kind === 'head' ? 'target' : ref.kind === 'remote' ? 'cloud' : ref.kind === 'tag' ? 'git-commit' : 'git-branch'} className="git-ref-icon" /><span className="git-ref-badge-name">{ref.name}</span></span>;
  const stats = summary?.statistics;
  return <article ref={card} className="git-commit-hover" data-git-graph-commit-hover={payload.commit}>
    <div className="git-commit-hover-author"><CommitHoverAvatar author={payload.author} github={githubAuthor} /><strong data-git-commit-hover-author={payload.commit}>{payload.author}</strong>{githubAuthor ? <span className="git-commit-hover-login" data-git-commit-hover-login>@{githubAuthor.login}</span> : <span className="git-commit-hover-email">{payload.authorEmail}</span>}<span className="git-commit-hover-meta">{relativeTime(payload.timestamp, document.documentElement.lang || 'en')} · {new Date(payload.timestamp).toLocaleString(document.documentElement.lang || 'en', { dateStyle: 'medium', timeStyle: 'short' })}</span></div>
    <div><strong data-git-commit-hover-subject={payload.commit}>{payload.subject}</strong>{commitBody(payload.subject, message) && <p className="git-commit-hover-body">{commitBody(payload.subject, message)}</p>}</div>
    <div className="git-commit-hover-stats">{loading && !stats ? defaultT('hover.statisticsPending') : error && !stats ? error : <>{defaultT(stats?.files === 1 ? 'hover.fileCount' : 'hover.fileCountPlural', { count: stats?.files ?? 0 })}{stats?.insertions ? <span className="git-commit-hover-add"> +{stats.insertions}</span> : null}{stats?.deletions ? <span className="git-commit-hover-remove"> −{stats.deletions}</span> : null}</>}</div>
    {presentation.primary && <div className="git-commit-hover-refs" data-commit-popover-refs={payload.commit}>{badge(presentation.primary.ref)}{presentation.secondary.map((group) => badge(group.refs[0]))}</div>}
    <div className="git-commit-hover-actions"><code>{payload.commit.slice(0, 10)}</code><button type="button" onClick={() => { void host.writeClipboard(payload.commit).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); }).catch(() => setError(defaultT('status.copyError'))); }}>{copied ? defaultT('hover.copied') : defaultT('hover.copyHash')}</button>{payload.remoteUrl && <button type="button" onClick={() => { void host.openUrl(payload.remoteUrl!).catch(() => setError(defaultT('hover.serviceError'))); }}>{defaultT('hover.openOnGitHub')}</button>}<button type="button" onClick={() => { void host.openCommit(payload.commit).catch(() => setError(defaultT('status.openError'))); }}>{defaultT('hover.openDiff')}</button></div>
    {error && <p className="git-commit-hover-error" role="alert">{error}</p>}
  </article>;
}

/** Child-frame card for kind:'hover'. A new payload/directory cannot show stale local state. */
export function CommitHoverCard(props: { host: HostClient; service: GitGraphServiceClient; directory: string; payload: CommitHoverPayload }): ReactNode {
  return <CommitHoverCardContent key={`${props.directory}:${props.payload.commit}`} {...props} />;
}
