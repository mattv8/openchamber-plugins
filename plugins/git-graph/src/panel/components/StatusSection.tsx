import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HostClient } from '@openchamber/sdk';
import { requestId, type GitGraphServiceClient, type GraphCommit, type GraphRef, type HistoryMode } from '../domain/index.js';
import { defaultT } from '../i18n/index.js';
import { CompactHistoryRow } from '../original/CompactHistoryRow.js';
import { GitGraphControls } from '../original/GitGraphControls.js';
import { buildGitHistoryViewModels, getHistoryItemMaxColumns } from '../original/gitGraph.js';
import { readGraphPrefs, writeGraphPrefs } from '../state/preferences.js';
import { CommitHoverProvider, useCommitHoverAnchor } from '../commit-hover/index.js';
import { useCommitMenuTrigger, useOperationRecovery } from '../commit-menu/index.js';
import { CommitFiles, nextExpandedCommit, type CommitFile } from './CommitFiles.js';
import type { CommitMenuPayload } from '../popover/payload.js';

type StatusState = 'loading' | 'empty' | 'error' | 'ready';
export function statusControlsFor(mode: HistoryMode, loading: boolean, preferencesReady = true) {
  return [
    { kind: 'select' as const, id: 'range', label: defaultT('status.range'), value: mode, options: (['auto', 'all', 'manual'] as const).map((value) => ({ value, label: defaultT(`status.mode.${value}`) })), ...(!preferencesReady ? { disabled: true } : {}) },
    { kind: 'button' as const, id: 'refresh', label: '↻', disabled: loading },
  ];
}

export function buildMenuPayload(commit: GraphCommit): CommitMenuPayload {
  return { kind: 'menu', commit: commit.id, subject: commit.subject.slice(0, 2_000), branches: commit.references.filter((ref) => ref.kind === 'local').map((ref) => ref.name.slice(0, 512)).slice(0, 20) };
}

export function isNotRepositoryResponse(response: unknown): boolean {
  return Boolean(response && typeof response === 'object' && 'ok' in response && (response as { ok: boolean }).ok === false && (response as { error?: { code?: string } }).error?.code === 'not-a-repository');
}

function normalizeCurrentRef(current: GraphRef | null, refs: readonly GraphRef[]): GraphRef | null {
  if (!current || current.id !== 'HEAD') return current;
  return refs.find((ref) => ref.kind === 'local' && ref.name === current.name && ref.revision === current.revision) ?? current;
}

function StatusHistoryRow({ viewModel, expanded, onToggle, loadFiles, fileRepository, onOpenCommit, host, popovers, menuEnabled, t }: { viewModel: ReturnType<typeof buildGitHistoryViewModels>[number]; expanded: boolean; onToggle(id: string): void; loadFiles(commit: GraphCommit, parent: string | null, repository: { repositoryId: string; snapshot: string } | null): Promise<readonly CommitFile[]>; fileRepository: { repositoryId: string; snapshot: string } | null; onOpenCommit(id: string): void; host: HostClient; popovers: boolean; menuEnabled: boolean; t: typeof defaultT }) {
  const commit = viewModel.historyItem;
  const hoverAnchor = useCommitHoverAnchor(commit, commit.references);
  const menuTrigger = useCommitMenuTrigger({ host, enabled: popovers && menuEnabled, getPayload: () => buildMenuPayload(commit) });
  return <><CompactHistoryRow viewModel={viewModel} expanded={expanded} onToggle={onToggle} hoverAnchor={hoverAnchor} menuTrigger={menuTrigger} t={t} />{expanded && <CommitFiles commit={commit.id} subject={commit.subject} parentIds={commit.parentIds} load={(parent) => loadFiles(commit, parent, fileRepository)} onOpenCommit={() => onOpenCommit(commit.id)} outputSwimlanes={viewModel.outputSwimlanes} totalColumns={getHistoryItemMaxColumns(viewModel)} t={t} />}</>;
}

export function StatusSection({ directory, service, host, features, refreshToken = 0, recoveryRevision = 0 }: { directory: string | null; service: GitGraphServiceClient; host: HostClient; features?: { deviceStorage?: true; statusControls?: true; popovers?: true } | undefined; refreshToken?: number; recoveryRevision?: number }) {
  const [mode, setMode] = useState<HistoryMode>('auto');
  const [manualRefs, setManualRefs] = useState<string[]>([]);
  const [refs, setRefs] = useState<GraphRef[]>([]);
  const [current, setCurrent] = useState<GraphRef | null>(null);
  const [upstream, setUpstream] = useState<GraphRef | null>(null);
  const [base, setBase] = useState<GraphRef | null>(null);
  const [mergeBase, setMergeBase] = useState<string | null>(null);
  const [commits, setCommits] = useState<GraphCommit[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [state, setState] = useState<StatusState>(directory ? 'loading' : 'empty');
  const [actionError, setActionError] = useState<string | null>(null);
  const [preferenceError, setPreferenceError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [preferenceReload, setPreferenceReload] = useState(0);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [repository, setRepository] = useState<{ directory: string; repositoryId: string; snapshot: string } | null>(null);
  const [expandedCommit, setExpandedCommit] = useState<string | null>(null);
  const directoryGeneration = useRef(0);
  const preferenceGeneration = useRef(0);
  const historyGeneration = useRef(0);
  const saveGeneration = useRef(0);
  const root = useRef<HTMLElement>(null);
  const scrollContainer = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const loadedDirectory = useRef<string | null>(null);
  const historyRequest = useRef<{ directory: string; repositoryId: string; snapshot: string; refs: string[]; generation: number } | null>(null);
  const appendPending = useRef<{ directory: string; repositoryId: string; snapshot: string; refs: string[]; generation: number } | null>(null);
  const filesCache = useRef(new Map<string, readonly CommitFile[]>());
  const statusControlHandlers = useRef<{ preferencesReady: boolean; controls: ReturnType<typeof statusControlsFor>; chooseMode(mode: HistoryMode): void; refresh(): void }>({ preferencesReady: false, controls: statusControlsFor('auto', true, false), chooseMode: () => undefined, refresh: () => undefined });
  const graphRows = useMemo(() => buildGitHistoryViewModels(commits, { current, upstream, base }, { showIncoming: true, showOutgoing: true, mergeBase }), [base, commits, current, mergeBase, upstream]);

  const savePreferences = useCallback((nextMode: HistoryMode, nextRefs: string[]) => {
    if (!directory) return;
    const directoryVersion = directoryGeneration.current;
    const saveVersion = ++saveGeneration.current;
    setPreferenceError(null);
    void writeGraphPrefs(host, directory, { mode: nextMode, refs: nextRefs.slice(0, 32) }, Boolean(features?.deviceStorage)).catch(() => {
      if (directoryVersion === directoryGeneration.current && saveVersion === saveGeneration.current) setPreferenceError(defaultT('status.preferencesSaveError'));
    });
  }, [directory, features?.deviceStorage, host]);

  useEffect(() => {
    const directoryVersion = ++directoryGeneration.current;
    const preferenceVersion = ++preferenceGeneration.current;
    loadedDirectory.current = null;
    setPreferencesReady(false);
    historyRequest.current = null; appendPending.current = null;
    setActionError(null); setPreferenceError(null); setPageError(null); setNextCursor(null); setHasMore(false); setIsLoadingMore(false); setCommits([]); setRefs([]); setCurrent(null); setUpstream(null); setBase(null); setMergeBase(null); setRepository(null); setExpandedCommit(null); filesCache.current.clear();
    if (!directory) { setState('empty'); return; }
    setState('loading');
    void readGraphPrefs(host, directory, Boolean(features?.deviceStorage)).then(({ prefs: stored }) => {
      if (directoryVersion !== directoryGeneration.current || preferenceVersion !== preferenceGeneration.current) return;
      loadedDirectory.current = directory;
      setMode(stored.mode); setManualRefs(stored.refs); setPreferencesReady(true);
    }).catch(() => {
      if (directoryVersion === directoryGeneration.current && preferenceVersion === preferenceGeneration.current) { setState('error'); setPreferenceError(defaultT('status.preferencesReadError')); }
    });
    return () => { preferenceGeneration.current += 1; };
  }, [directory, features?.deviceStorage, host, preferenceReload]);

  useEffect(() => {
    if (!directory || !preferencesReady || loadedDirectory.current !== directory) return;
    const directoryVersion = directoryGeneration.current;
    const historyVersion = ++historyGeneration.current;
    const isCurrent = () => directoryVersion === directoryGeneration.current && historyVersion === historyGeneration.current;
    historyRequest.current = null;
    appendPending.current = null;
    setState('loading');
    setPageError(null); setNextCursor(null); setHasMore(false); setIsLoadingMore(false);
    void (async () => {
      try {
        const opened = await service.request({ version: 1, requestId: requestId('status-open'), repositoryId: 'status', operation: 'repo/open', directory });
        if (!isCurrent()) return;
        if (!opened.ok || opened.operation !== 'repo/open') { setState(isNotRepositoryResponse(opened) ? 'empty' : 'error'); return; }
        setRepository({ directory, repositoryId: opened.data.id, snapshot: opened.data.snapshot });
        const refResponse = await service.request({ version: 1, requestId: requestId('status-refs'), repositoryId: opened.data.id, snapshot: opened.data.snapshot, operation: 'read', read: 'refs' });
        if (!isCurrent()) return;
        if (!refResponse.ok || refResponse.operation !== 'read' || refResponse.data.read !== 'refs') { setState('error'); return; }
        const { current: attachedCurrent, upstream: nextUpstream, base: nextBase, refs: nextRefs } = refResponse.data;
        const nextCurrent = normalizeCurrentRef(attachedCurrent, nextRefs);
        const available = new Set(nextRefs.map((ref) => ref.id));
        const autoRefs = [nextCurrent?.id, nextUpstream?.id, nextBase?.id].filter((ref): ref is string => Boolean(ref && available.has(ref)));
        const selectedRefs = mode === 'all' ? ['*'] : mode === 'manual'
          ? manualRefs.filter((ref) => available.has(ref))
          : [...new Set(autoRefs)];
        const historyRefs = selectedRefs.length ? selectedRefs : ['HEAD'];
        setRefs(nextRefs); setCurrent(nextCurrent); setUpstream(nextUpstream); setBase(nextBase);
        let nextMergeBase: string | null = null;
        const comparisonRefs = [nextCurrent?.id, nextUpstream?.id ?? nextBase?.id].filter((ref): ref is string => Boolean(ref));
        if (comparisonRefs.length === 2) {
          // SAFETY: the length check establishes the two entries required by merge-base.
          const mergeBaseResponse = await service.request({ version: 1, requestId: requestId('status-merge-base'), repositoryId: opened.data.id, snapshot: opened.data.snapshot, operation: 'read', read: 'merge-base', refs: comparisonRefs as [string, string] });
          if (!isCurrent()) return;
          if (mergeBaseResponse.ok && mergeBaseResponse.operation === 'read' && mergeBaseResponse.data.read === 'merge-base') nextMergeBase = mergeBaseResponse.data.mergeBase;
        }
        setMergeBase(nextMergeBase);
        const history = await service.request({ version: 1, requestId: requestId('status-history'), repositoryId: opened.data.id, snapshot: opened.data.snapshot, operation: 'read', read: 'history', refs: historyRefs, cursor: null, limit: 100 });
        if (!isCurrent()) return;
        if (!history.ok || history.operation !== 'read' || history.data.read !== 'history') { setState('error'); return; }
        historyRequest.current = { directory, repositoryId: opened.data.id, snapshot: opened.data.snapshot, refs: historyRefs, generation: historyVersion };
        setCommits(history.data.items); setNextCursor(history.data.nextCursor); setHasMore(history.data.hasMore); setState(history.data.items.length ? 'ready' : 'empty');
      } catch {
        if (isCurrent()) setState('error');
      }
    })();
    return () => {
      if (historyRequest.current?.generation === historyVersion) historyRequest.current = null;
      if (appendPending.current?.generation === historyVersion) appendPending.current = null;
      historyGeneration.current += 1;
    };
  }, [directory, manualRefs, mode, preferencesReady, reload, service]);

  useEffect(() => { if (refreshToken) setReload((value) => value + 1); }, [refreshToken]);
  const loadNextPage = useCallback(() => {
    const request = historyRequest.current;
    if (!request || !hasMore || !nextCursor || appendPending.current || isLoadingMore || pageError) return;
    appendPending.current = request;
    setIsLoadingMore(true);
    void service.request({ version: 1, requestId: requestId('status-history-more'), repositoryId: request.repositoryId, snapshot: request.snapshot, operation: 'read', read: 'history', refs: request.refs, cursor: nextCursor, limit: 100 }).then((history) => {
      const latest = historyRequest.current;
      if (latest !== request || historyGeneration.current !== request.generation) return;
      if (!history.ok || history.operation !== 'read' || history.data.read !== 'history') { setPageError(defaultT('status.error')); return; }
      const page = history.data;
      setCommits((previous) => {
        const known = new Set(previous.map((commit) => commit.id));
        return previous.concat(page.items.filter((commit) => !known.has(commit.id)));
      });
      setNextCursor(page.nextCursor); setHasMore(page.hasMore);
    }).catch(() => {
      const latest = historyRequest.current;
      if (latest === request && historyGeneration.current === request.generation) setPageError(defaultT('status.error'));
    }).finally(() => {
      const latest = historyRequest.current;
      if (latest === request && historyGeneration.current === request.generation) {
        setIsLoadingMore(false);
        if (appendPending.current === request) appendPending.current = null;
      }
    });
  }, [hasMore, isLoadingMore, nextCursor, pageError, service]);
  useEffect(() => {
    const container = scrollContainer.current;
    const end = sentinel.current;
    if (!container || !end || !hasMore || !nextCursor || pageError || !globalThis.IntersectionObserver) return;
    const observer = new IntersectionObserver((entries) => { if (entries[0]?.isIntersecting) loadNextPage(); }, { root: container });
    observer.observe(end);
    return () => observer.disconnect();
  }, [hasMore, loadNextPage, nextCursor, pageError]);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    let reported = -1;
    const report = () => { const height = Math.min(320, Math.ceil(element.scrollHeight)); if (height !== reported) { reported = height; void host.setHeight(height).catch(() => undefined); } };
    const observer = new ResizeObserver(report); observer.observe(element); report(); return () => observer.disconnect();
  }, [host.setHeight]);

  const chooseMode = (next: HistoryMode) => { if (!preferencesReady) return; setMode(next); savePreferences(next, manualRefs); };
  const refresh = () => { if (directory && !preferencesReady) setPreferenceReload((value) => value + 1); else setReload((value) => value + 1); };
  statusControlHandlers.current = { preferencesReady, controls: statusControlsFor(mode, state === 'loading', preferencesReady), chooseMode, refresh };
  const toggleRef = (id: string) => { if (!preferencesReady) return; const next = manualRefs.includes(id) ? manualRefs.filter((ref) => ref !== id) : [...manualRefs, id]; setManualRefs(next); savePreferences(mode, next); };
  const openCommit = (id: string) => { setActionError(null); void host.openCommit(id).catch((error) => setActionError(error instanceof Error ? error.message : defaultT('status.openError'))); };
  const loadFiles = useCallback(async (commit: GraphCommit, parent: string | null, fileRepository: { repositoryId: string; snapshot: string } | null): Promise<readonly CommitFile[]> => {
    if (!fileRepository) throw new Error('repository unavailable');
    const key = `${fileRepository.snapshot}:${commit.id}:${parent ?? ''}`;
    const cached = filesCache.current.get(key); if (cached) return cached;
    const response = await service.request({ version: 1, requestId: requestId('status-files'), repositoryId: fileRepository.repositoryId, snapshot: fileRepository.snapshot, operation: 'read', read: 'commit-files', commit: commit.id, parent });
    if (!response.ok || response.operation !== 'read' || response.data.read !== 'commit-files') throw new Error('files unavailable');
    filesCache.current.set(key, response.data.files); return response.data.files;
  }, [service]);
  const { recovery, blocked, acknowledge } = useOperationRecovery({ host, service, repositoryId: repository?.repositoryId ?? null, enabled: Boolean(features?.popovers && features?.deviceStorage), revision: recoveryRevision, onSettled: () => setReload((value) => value + 1) });

  useEffect(() => {
    if (!features?.statusControls) return;
    const unsubscribe = host.onStatusControl((event) => {
      if (event.id === 'range' && (event.value === 'auto' || event.value === 'all' || event.value === 'manual')) {
        if (statusControlHandlers.current.preferencesReady) statusControlHandlers.current.chooseMode(event.value);
        else void host.setStatusControls(statusControlHandlers.current.controls).catch(() => undefined);
      }
      if (event.id === 'refresh') statusControlHandlers.current.refresh();
    });
    return () => { unsubscribe(); void host.setStatusControls([]).catch(() => undefined); };
  }, [features?.statusControls, host]);
  useEffect(() => { if (features?.statusControls) void host.setStatusControls(statusControlsFor(mode, state === 'loading', preferencesReady)).catch(() => undefined); }, [features?.statusControls, host, mode, preferencesReady, state]);

  return <CommitHoverProvider host={host} service={service} repository={repository} enabled={Boolean(features?.popovers)}><section ref={root} className="git-status-section" data-git-graph-status="true" aria-label={defaultT('status.sectionLabel')}>
    {!features?.statusControls && <header className="git-status-toolbar"><GitGraphControls mode={mode} disabled={!preferencesReady} loading={state === 'loading'} onModeChange={chooseMode} onRefresh={refresh} t={defaultT} /></header>}
    {mode === 'manual' && <div className="git-status-ref-picker" aria-label={defaultT('status.refs')}>{refs.filter((ref) => ref.kind !== 'tag').slice(0, 32).map((ref) => <label key={ref.id}><input type="checkbox" disabled={!preferencesReady} checked={manualRefs.includes(ref.id)} onChange={() => toggleRef(ref.id)} />{ref.name}</label>)}</div>}
    {/* A reload keeps the current rows in place; a status line above them would shift the graph under the pointer. */}
    {state === 'loading' && graphRows.length === 0 && <p aria-busy="true">{defaultT('status.loading')}</p>}
    {state === 'error' && <p role="alert">{defaultT('status.error')}</p>}
    {state === 'empty' && <p>{directory ? defaultT(repository ? 'status.empty' : 'status.notRepository') : defaultT('status.noDirectory')}</p>}
    {graphRows.length > 0 && <div ref={scrollContainer} className="git-status-commits" aria-label={defaultT('status.commitList')} style={{ maxHeight: '264px', overflowY: 'auto' }}>{graphRows.map((row) => <StatusHistoryRow key={`${row.kind}:${row.historyItem.id}`} viewModel={row} expanded={expandedCommit === row.historyItem.id} onToggle={(id) => setExpandedCommit((current) => nextExpandedCommit(current, id))} loadFiles={loadFiles} fileRepository={repository} onOpenCommit={openCommit} host={host} popovers={Boolean(features?.popovers)} menuEnabled={Boolean(features?.deviceStorage) && !blocked} t={defaultT} />)}{hasMore && <div ref={sentinel} data-git-graph-end-sentinel="true" aria-hidden="true" style={{ height: '1px' }} />}{isLoadingMore && <p aria-busy="true">{defaultT('status.loading')}</p>}{pageError && <p role="alert">{pageError}</p>}</div>}
    {recovery.state === 'running' && <p data-git-graph-recovery="running" role="status">{defaultT('status.recoveryRunning')}</p>}
    {recovery.state === 'failed' && <p data-git-graph-recovery="failed" role="alert">{defaultT('status.recoveryFailed', { message: recovery.message })}<button type="button" onClick={acknowledge}>{defaultT('status.acknowledge')}</button></p>}
    {recovery.state === 'unknown' && <p data-git-graph-recovery="unknown" role="alert">{defaultT('status.recoveryUnknown')}<button type="button" onClick={acknowledge}>{defaultT('status.acknowledge')}</button></p>}
    {actionError && <p className="git-status-error" role="alert">{actionError}</p>}
    {preferenceError && <p className="git-status-error" role="alert">{preferenceError}</p>}
  </section></CommitHoverProvider>;
}
