import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { z } from 'zod';
import type { GitGraphMutation, GitGraphRequest } from '../../shared/protocol.js';
import { buildGraph, collectDiffChunks, historyRefsForMode, requestId, type DiffChunk, type HistoryMode, type MutationIntent, type ResolvedGitGraphResponse, type WorkspaceProps } from '../domain/index.js';
import { SideBySideDiff } from '../diff/SideBySideDiff.js';
import { defaultT } from '../i18n/index.js';
import { historicalPreviewRequest, initialWorkspaceState, responseBelongsTo, type HistoricalFile, workspaceReducer } from '../state/workspace.js';
import { ConfirmMutationDialog } from './ConfirmMutationDialog.js';
import { GitActions } from './GitActions.js';
import { GraphSvg } from './GraphSvg.js';
import { HistoricalFiles } from './HistoricalFiles.js';
import { HistoryControls } from './HistoryControls.js';

type RequestContext = { repositoryId: string; snapshot: string; generation: number };
type MutationSlot = { active: string | null; unknown: string | null };
type PendingConfirmation = { intent: MutationIntent; context: RequestContext };
const request = <T extends GitGraphRequest>(value: T): T => value;
const PanelChunkSchema = z.object({ snapshot: z.string(), chunkId: z.string(), offset: z.number(), totalBytes: z.number(), complete: z.boolean(), text: z.string(), isBinary: z.boolean(), truncated: z.boolean() });
function chunkFrom(data: object) { const value = 'chunk' in data ? PanelChunkSchema.safeParse(data.chunk) : { success: false as const }; return value.success ? value.data : null; }
function mutationSlot(slots: Map<string, MutationSlot>, repositoryId: string): MutationSlot { const existing = slots.get(repositoryId); if (existing) return existing; const next = { active: null, unknown: null }; slots.set(repositoryId, next); return next; }

export function Workspace({ directory, service, host, active = true, pollIntervalMs = 15000, initialCommit = null, t = defaultT }: WorkspaceProps) {
  const [state, dispatch] = useReducer(workspaceReducer, undefined, initialWorkspaceState);
  const [message, setMessage] = useState('');
  const [filter, setFilter] = useState('');
  const [historyMode, setHistoryMode] = useState<HistoryMode>('auto');
  const [manualRefs, setManualRefs] = useState('');
  const [compareBase, setCompareBase] = useState('');
  const [compareHead, setCompareHead] = useState('HEAD');
  const [rangeFiles, setRangeFiles] = useState<readonly { path: string; previousPath: string | null; isBinary: boolean }[]>([]);
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null);
  const context = useRef<RequestContext | null>(null);
  const mounted = useRef(true);
  const repositoryGeneration = useRef(0);
  const readGenerations = useRef<Record<'working-tree' | 'refs' | 'history', number>>({ 'working-tree': 0, refs: 0, history: 0 });
  const historicalGeneration = useRef(0);
  const consumedInitialCommit = useRef<string | null>(null);
  const stateRef = useRef(state);
  const mutationsByRepository = useRef(new Map<string, MutationSlot>());
  const serviceRef = useRef(service);
  const hostRef = useRef(host);
  const tRef = useRef(t);
  const historyModeRef = useRef(historyMode);
  const manualRefsRef = useRef(manualRefs);
  stateRef.current = state;
  serviceRef.current = service;
  hostRef.current = host;
  tRef.current = t;
  historyModeRef.current = historyMode;
  manualRefsRef.current = manualRefs;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; repositoryGeneration.current += 1; };
  }, []);
  const reportError = useCallback((message: string) => { if (mounted.current) dispatch({ type: 'error', message }); hostRef.current?.toast?.(message, 'error'); }, []);
  const valid = useCallback((candidate: RequestContext) => mounted.current && responseBelongsTo({ repositoryId: context.current?.repositoryId ?? null, generation: repositoryGeneration.current }, { repositoryId: candidate.repositoryId, generation: candidate.generation }), []);
  const sameRepository = useCallback((candidate: RequestContext) => mounted.current && context.current?.repositoryId === candidate.repositoryId, []);
  const read = useCallback(async (candidate: RequestContext, kind: 'working-tree' | 'refs' | 'history', append = false) => {
    const queryGeneration = ++readGenerations.current[kind];
    const base = { version: 1 as const, requestId: requestId('read'), repositoryId: candidate.repositoryId, snapshot: candidate.snapshot, operation: 'read' as const };
    const latest = stateRef.current;
    const result = await serviceRef.current.request(kind === 'history' ? request({ ...base, read: 'history' as const, refs: historyRefsForMode(historyModeRef.current, latest.current?.id ?? null, manualRefsRef.current), cursor: append ? latest.cursor : null, limit: 100 }) : request({ ...base, read: kind }));
    if (!valid(candidate) || queryGeneration !== readGenerations.current[kind]) return false;
    if (!result.ok) { reportError(result.error.message); return false; }
    if (result.operation === 'read') dispatch({ type: 'read', data: result.data, append });
    return true;
  }, [reportError, valid]);
  const loadDiff = useCallback(async (candidate: RequestContext, tab: { id: string }, loadChunk: (offset: number) => Promise<ResolvedGitGraphResponse>, hunks: readonly { id: string; oldStart: number; oldLines: number; newStart: number; newLines: number }[] = []) => {
    try {
      const diff = await collectDiffChunks(candidate.snapshot, async (offset): Promise<DiffChunk> => {
        const result = await loadChunk(offset);
        if (!valid(candidate)) throw new Error('stale diff response');
        if (!result.ok) throw new Error(result.error.message);
        const chunk = result.operation === 'read' ? chunkFrom(result.data) : null;
        if (!chunk) throw new Error(tRef.current('workspace.error'));
        return chunk;
      });
      if (valid(candidate)) dispatch({ type: 'diff', id: tab.id, diff: { ...diff, hunks } });
    } catch (error) {
      if (valid(candidate)) reportError(error instanceof Error ? error.message : tRef.current('workspace.error'));
    }
  }, [reportError, valid]);
  const openRepository = useCallback(async () => {
    if (!active) return;
    const currentGeneration = ++repositoryGeneration.current;
    dispatch({ type: 'loading', value: true });
    try {
      const result = await serviceRef.current.request(request({ version: 1, requestId: requestId('open'), repositoryId: 'panel', operation: 'repo/open', directory }));
      if (!mounted.current || currentGeneration !== repositoryGeneration.current) return;
      if (!result.ok) { reportError(result.error.message); return; }
      if (result.operation !== 'repo/open') { reportError(tRef.current('workspace.error')); return; }
      const next = { repositoryId: result.data.id, snapshot: result.data.snapshot, generation: currentGeneration };
      context.current = next; dispatch({ type: 'opened', id: next.repositoryId, snapshot: next.snapshot });
      dispatch({ type: 'mutation-unknown', id: mutationsByRepository.current.get(next.repositoryId)?.unknown ?? null });
      await Promise.all([read(next, 'working-tree'), read(next, 'refs'), read(next, 'history')]);
    } catch (error) {
      if (mounted.current && currentGeneration === repositoryGeneration.current) { reportError(error instanceof Error ? error.message : tRef.current('workspace.error')); }
    } finally {
      if (mounted.current && currentGeneration === repositoryGeneration.current) dispatch({ type: 'loading', value: false });
    }
  }, [active, directory, read, reportError]);
  useEffect(() => { void openRepository(); }, [active, directory, service]);
  const refreshRepository = useCallback(async () => {
    const candidate = context.current;
    if (!active || !candidate) return;
    try {
      const refreshed = await serviceRef.current.request(request({ version: 1, requestId: requestId('refresh'), repositoryId: candidate.repositoryId, snapshot: candidate.snapshot, operation: 'refresh' }));
      if (!valid(candidate) || !refreshed.ok || refreshed.operation !== 'refresh') return;
      const next = { ...candidate, snapshot: refreshed.data.snapshot };
      context.current = next;
      dispatch({ type: 'opened', id: next.repositoryId, snapshot: next.snapshot });
      if (refreshed.data.changed) await Promise.all([read(next, 'working-tree'), read(next, 'refs'), read(next, 'history')]);
    } catch (error) { if (valid(candidate)) reportError(error instanceof Error ? error.message : tRef.current('workspace.error')); }
  }, [active, read, reportError, valid]);
  useEffect(() => {
    if (!active || !context.current) return;
    const timer = window.setInterval(() => { void refreshRepository(); }, pollIntervalMs);
    return () => window.clearInterval(timer);
  }, [active, pollIntervalMs, refreshRepository, state.repositoryId]);
  const runMutation = useCallback(async (intent: MutationIntent, candidate = context.current): Promise<boolean> => {
    const latest = stateRef.current;
    if (!candidate || !valid(candidate)) return false;
    const slot = mutationSlot(mutationsByRepository.current, candidate.repositoryId);
    if (slot.active || slot.unknown || (latest.repositoryId === candidate.repositoryId && (latest.pending.size > 0 || latest.unknownMutation))) return false;
    const operationId = requestId('mutation');
    slot.active = operationId;
    dispatch({ type: 'pending', id: operationId, value: true });
    try {
      const result = await serviceRef.current.request(request({ version: 1, requestId: requestId('mutate'), repositoryId: candidate.repositoryId, snapshot: candidate.snapshot, operation: 'mutate', operationId, expectedSnapshot: candidate.snapshot, action: intent.action }));
      if (!result.ok) {
        if (result.error.code === 'timeout-unknown' || result.error.code === 'job-lost') slot.unknown = operationId;
        if (sameRepository(candidate)) { if (slot.unknown === operationId) dispatch({ type: 'mutation-unknown', id: operationId }); reportError(result.error.message); }
        return false;
      }
      if (!sameRepository(candidate)) return false;
      if (result.operation !== 'mutate' || !('result' in result.data)) { slot.unknown = operationId; dispatch({ type: 'mutation-unknown', id: operationId }); reportError(tRef.current('workspace.pendingJob')); return false; }
      hostRef.current?.toast?.(result.data.result.message ?? tRef.current('workspace.success'), 'success'); void openRepository(); return true;
    } catch (error) {
      slot.unknown = operationId;
      if (sameRepository(candidate)) { dispatch({ type: 'mutation-unknown', id: operationId }); reportError(error instanceof Error ? error.message : tRef.current('workspace.pendingJob')); }
      return false;
    } finally {
      if (slot.active === operationId) slot.active = null;
      if (!slot.active && !slot.unknown) mutationsByRepository.current.delete(candidate.repositoryId);
      if (sameRepository(candidate) && mounted.current) dispatch({ type: 'pending', id: operationId, value: false });
    }
  }, [openRepository, reportError, sameRepository, valid]);
  const askMutation = useCallback((intent: MutationIntent) => {
    const candidate = context.current;
    if (!candidate || !valid(candidate)) return;
    if (intent.destructive || intent.action.mutation === 'commit') setConfirmation({ intent, context: candidate });
    else void runMutation(intent, candidate);
  }, [runMutation, valid]);
  const acknowledgeUnknownMutation = useCallback(() => {
    const candidate = context.current;
    if (!candidate) return;
    const slot = mutationsByRepository.current.get(candidate.repositoryId);
    if (!slot?.unknown) return;
    slot.unknown = null;
    if (!slot.active) mutationsByRepository.current.delete(candidate.repositoryId);
    dispatch({ type: 'mutation-unknown', id: null });
    void refreshRepository();
  }, [refreshRepository]);
  const openWorking = useCallback(async (path: string, scope: 'staged' | 'unstaged') => {
    const candidate = context.current; if (!candidate) return;
    const tab = { id: `working:${scope}:${path}`, title: `${scope}: ${path}`, kind: 'working' as const, path, scope, commit: null, parent: null, originalPath: null, modifiedPath: path };
    dispatch({ type: 'tab', tab });
    const hunks = await service.request(request({ version: 1, requestId: requestId('hunks'), repositoryId: candidate.repositoryId, snapshot: candidate.snapshot, operation: 'read', read: 'hunks', path, scope }));
    if (!valid(candidate)) return;
    await loadDiff(candidate, tab, (offset) => service.request(request({ version: 1, requestId: requestId('diff'), repositoryId: candidate.repositoryId, snapshot: candidate.snapshot, operation: 'read', read: 'working-tree-diff', path, scope, offset, limit: 240000 })), hunks.ok && hunks.operation === 'read' && hunks.data.read === 'hunks' ? hunks.data.hunks : []);
  }, [loadDiff, service, valid]);
  const loadHistoricalFiles = useCallback(async (commit: string, title: string, parentIds: readonly string[], parent: string | null) => {
    const candidate = context.current; if (!candidate) return;
    const currentHistoricalGeneration = ++historicalGeneration.current;
    const files = await service.request(request({ version: 1, requestId: requestId('files'), repositoryId: candidate.repositoryId, snapshot: candidate.snapshot, operation: 'read', read: 'commit-files', commit, parent }));
    if (!valid(candidate) || currentHistoricalGeneration !== historicalGeneration.current) return;
    if (!files.ok) { reportError(files.error.message); return; }
    if (files.operation !== 'read' || files.data.read !== 'commit-files') return;
    dispatch({ type: 'historical-files', commit, title, parentIds, parent, files: files.data.files });
  }, [reportError, service, valid]);
  const openCommit = useCallback((commit: string, title: string, parentIds: readonly string[]) => {
    dispatch({ type: 'select-commit', commit });
    void loadHistoricalFiles(commit, title, parentIds, parentIds[0] ?? null);
  }, [loadHistoricalFiles]);
  useEffect(() => {
    const candidate = context.current;
    if (!candidate || !initialCommit) return;
    const contextKey = `${candidate.repositoryId}:${initialCommit}`;
    if (consumedInitialCommit.current === contextKey) return;
    consumedInitialCommit.current = contextKey;
    void (async () => {
      const resolved = await service.request(request({ version: 1, requestId: requestId('resolve-commit'), repositoryId: candidate.repositoryId, snapshot: candidate.snapshot, operation: 'read', read: 'resolve-commit', candidate: initialCommit }));
        if (!valid(candidate) || !resolved.ok || resolved.operation !== 'read' || resolved.data.read !== 'resolve-commit' || !resolved.data.commit || resolved.data.ambiguous) { if (valid(candidate)) reportError(tRef.current('workspace.error')); return; }
      const history = await service.request(request({ version: 1, requestId: requestId('targeted-history'), repositoryId: candidate.repositoryId, snapshot: candidate.snapshot, operation: 'read', read: 'history', refs: [resolved.data.commit], cursor: null, limit: 1 }));
      if (!valid(candidate)) return;
      const item = history.ok && history.operation === 'read' && history.data.read === 'history' ? history.data.items[0] : null;
      if (item) { openCommit(item.id, item.subject, item.parentIds); return; }
      dispatch({ type: 'select-commit', commit: resolved.data.commit });
      await loadHistoricalFiles(resolved.data.commit, resolved.data.commit.slice(0, 8), [], null);
    })().catch((error) => { if (valid(candidate)) reportError(error instanceof Error ? error.message : tRef.current('workspace.error')); });
  }, [initialCommit, loadHistoricalFiles, openCommit, reportError, state.repositoryId, valid]);
  const changeHistoricalParent = useCallback((parent: string) => {
    const historical = stateRef.current.historical;
    if (historical) void loadHistoricalFiles(historical.commit, historical.title, historical.parentIds, parent);
  }, [loadHistoricalFiles]);
  const openHistoricalFile = useCallback(async (file: HistoricalFile) => {
    const candidate = context.current; const historical = stateRef.current.historical;
    if (!candidate || !historical) return;
    const preview = historicalPreviewRequest({ repositoryId: candidate.repositoryId, snapshot: candidate.snapshot, requestId: requestId('preview'), commit: historical.commit, parent: historical.parent, file, offset: 0 });
    const tab = { id: `commit:${historical.commit}:${historical.parent ?? 'root'}:${preview.originalPath ?? ''}:${preview.modifiedPath ?? ''}`, title: `${historical.title}: ${file.path}`, kind: 'commit' as const, path: file.path, scope: null, commit: historical.commit, parent: historical.parent, originalPath: preview.originalPath, modifiedPath: preview.modifiedPath };
    dispatch({ type: 'tab', tab });
    await loadDiff(candidate, tab, (offset) => service.request(request({ ...preview, requestId: requestId('preview'), offset })));
  }, [loadDiff, service]);
  const loadRangeFiles = useCallback(async () => {
    const candidate = context.current;
    if (!candidate || !compareBase.trim() || !compareHead.trim()) return;
    try {
      const result = await service.request(request({ version: 1, requestId: requestId('range-files'), repositoryId: candidate.repositoryId, snapshot: candidate.snapshot, operation: 'read', read: 'range-files', base: compareBase.trim(), head: compareHead.trim(), includeWorkingTree: false }));
      if (!valid(candidate)) return;
      if (!result.ok) { reportError(result.error.message); return; }
      if (result.operation === 'read' && result.data.read === 'range-files') setRangeFiles(result.data.files);
    } catch (error) { reportError(error instanceof Error ? error.message : t('workspace.error')); }
  }, [compareBase, compareHead, reportError, service, t, valid]);
  const openRangeFile = useCallback(async (path: string) => {
    const candidate = context.current;
    if (!candidate || !compareBase.trim() || !compareHead.trim()) return;
    const tab = { id: `range:${compareBase}:${compareHead}:${path}`, title: `${compareBase}…${compareHead}: ${path}`, kind: 'range' as const, path, scope: null, commit: null, parent: null, originalPath: null, modifiedPath: path };
    dispatch({ type: 'tab', tab });
    try {
      await loadDiff(candidate, tab, (offset) => service.request(request({ version: 1, requestId: requestId('range-diff'), repositoryId: candidate.repositoryId, snapshot: candidate.snapshot, operation: 'read', read: 'range-diff', base: compareBase.trim(), head: compareHead.trim(), path, includeWorkingTree: false, offset, limit: 240000 })));
    } catch (error) { reportError(error instanceof Error ? error.message : t('workspace.error')); }
  }, [compareBase, compareHead, loadDiff, reportError, service, t]);
  const selected = state.tabs.tabs.find((tab) => tab.id === state.tabs.activeId) ?? null;
  const selectedDiff = selected ? state.diffs.get(selected.id) : undefined;
  const rows = buildGraph(state.history, state.current);
  const files = state.files.filter((file) => file.path.toLowerCase().includes(filter.toLowerCase()));
  const currentMutation = context.current ? mutationsByRepository.current.get(context.current.repositoryId) : null;
  const mutationPending = state.pending.size > 0 || !!state.unknownMutation || !!currentMutation?.active || !!currentMutation?.unknown;
  return <main className="git-workspace" data-git-graph-workspace="true">
    <header className="git-toolbar"><button disabled={mutationPending} onClick={() => void openRepository()} aria-label={t('workspace.refresh')}>{t('workspace.refresh')}</button><button disabled={mutationPending} onClick={() => askMutation({ title: t('workspace.fetch'), message: t('workspace.fetch'), destructive: false, action: { mutation: 'fetch', remote: null } })}>{t('workspace.fetch')}</button><button disabled={mutationPending} onClick={() => askMutation({ title: t('workspace.pull'), message: t('workspace.pull'), destructive: false, action: { mutation: 'pull', remote: null, branch: null, rebase: false } })}>{t('workspace.pull')}</button><button disabled={mutationPending} onClick={() => askMutation({ title: t('workspace.push'), message: t('workspace.push'), destructive: false, action: { mutation: 'push', remote: null, branch: null, forceWithLease: false } })}>{t('workspace.push')}</button></header>
    {state.error && <div className="git-error" role="alert">{state.error}<button disabled={mutationPending} onClick={() => void openRepository()}>{t('workspace.retry')}</button></div>}
    {state.unknownMutation && <div className="git-error" role="alert">{t('workspace.pendingJob')} ({state.unknownMutation})<button onClick={acknowledgeUnknownMutation}>{t('workspace.refresh')}</button></div>}
    <div className="git-columns" data-git-graph-layout="split">
      <aside className="git-sidebar" data-git-graph-sidebar="true">
        <section className="git-changes" data-git-graph-changes="true"><h2>{t('workspace.changes')}</h2><input value={filter} onChange={(event) => setFilter(event.target.value)} aria-label={t('workspace.files')} placeholder={t('workspace.files')} />{files.length === 0 ? <p>{t('workspace.noChanges')}</p> : files.map((file) => <div className="git-file" key={file.path}><span>{file.path}</span>{file.staged && <><button onClick={() => void openWorking(file.path, 'staged')}>{t('workspace.staged')}</button><button disabled={mutationPending} onClick={() => askMutation({ title: t('workspace.unstage'), message: file.path, destructive: false, action: { mutation: 'unstage-path', path: file.path } })}>{t('workspace.unstage')}</button></>}{file.unstaged && <><button onClick={() => void openWorking(file.path, 'unstaged')}>{t('workspace.unstaged')}</button><button disabled={mutationPending} onClick={() => askMutation({ title: t('workspace.stage'), message: file.path, destructive: false, action: { mutation: 'stage-path', path: file.path } })}>{t('workspace.stage')}</button></>}</div>)}</section>
        <section className="git-history" data-git-graph-history="true"><HistoryControls mode={historyMode} manualRefs={manualRefs} t={t} onMode={setHistoryMode} onManualRefs={setManualRefs} onApply={() => { const candidate = context.current; if (candidate) void read(candidate, 'history'); }} /><ul>{rows.map((row) => <li data-git-graph-commit={row.commit.id} key={row.commit.id}><button className="git-commit-row" aria-pressed={state.selectedCommit === row.commit.id} onClick={() => openCommit(row.commit.id, row.commit.subject, row.commit.parentIds)}><GraphSvg row={row} /><span>{row.commit.subject}</span>{row.commit.references.map((ref) => <em key={ref.id}>{ref.name}</em>)}<small>{row.commit.id.slice(0, 8)}</small></button></li>)}</ul>{state.hasMore && <button onClick={() => { const candidate = context.current; if (candidate) void read(candidate, 'history', true); }}>{t('workspace.loadMore')}</button>}<HistoricalFiles selection={state.historical} t={t} onParentChange={changeHistoricalParent} onOpenFile={openHistoricalFile} /></section>
        <section className="git-compare" data-git-graph-compare="true"><h2>{t('workspace.compare')}</h2><input value={compareBase} onChange={(event) => setCompareBase(event.target.value)} aria-label={t('workspace.branch')} placeholder={t('workspace.branch')} /><input value={compareHead} onChange={(event) => setCompareHead(event.target.value)} aria-label={t('workspace.compare')} /><button disabled={!compareBase.trim() || !compareHead.trim()} onClick={() => void loadRangeFiles()}>{t('workspace.compare')}</button>{rangeFiles.map((file) => <button key={file.path} onClick={() => void openRangeFile(file.path)}>{file.isBinary ? `${file.path} (${t('workspace.binary')})` : file.path}</button>)}</section>
        <section className="git-commit-form"><textarea value={message} onChange={(event) => setMessage(event.target.value)} placeholder={t('workspace.commitMessage')} aria-label={t('workspace.commitMessage')} /><button disabled={!message.trim() || mutationPending} onClick={() => void runMutation({ title: t('workspace.commit'), message: `${t('workspace.commitAction')}: ${message}`, destructive: true, action: { mutation: 'commit', message } }).then((success) => { if (success) setMessage(''); })}>{t('workspace.commit')}</button></section>
        <GitActions refs={state.refs} stashes={state.stashes} selectedCommit={state.selectedCommit} attention={state.attention} pending={mutationPending} onAction={askMutation} t={t} />
      </aside>
      <section className="git-tabs" data-git-graph-tabs="true"><div className="git-tab-list">{state.tabs.tabs.map((tab) => <div key={tab.id}><button type="button" aria-pressed={tab.id === selected?.id} onClick={() => dispatch({ type: 'tab', tab })}>{tab.title}</button><button type="button" aria-label={t('workspace.close')} onClick={() => dispatch({ type: 'close-tab', id: tab.id })}>×</button></div>)}</div>{selectedDiff ? <SideBySideDiff text={selectedDiff.text} isBinary={selectedDiff.binary} truncated={selectedDiff.truncated} hunks={selectedDiff.hunks} disabled={mutationPending} labels={{ binary: t('workspace.binary'), truncated: t('workspace.truncated'), stage: t('workspace.hunkStage'), unstage: t('workspace.hunkUnstage'), discard: t('workspace.hunkDiscard') }} onHunkAction={(hunkId, action) => selected?.kind === 'working' && selected.path && selected.scope && askMutation({ title: t(`workspace.${action === 'stage-hunk' ? 'stage' : action === 'unstage-hunk' ? 'unstage' : 'discard'}`), message: selected.path, destructive: action === 'discard-hunk', action: { mutation: action, path: selected.path, hunkId } as GitGraphMutation })} /> : <p className="git-diff-notice">{t('workspace.tabs')}</p>}</section>
    </div>
    <ConfirmMutationDialog intent={confirmation?.intent ?? null} t={t} onCancel={() => setConfirmation(null)} onConfirm={() => { const pending = confirmation; setConfirmation(null); if (pending) void runMutation(pending.intent, pending.context); }} />
  </main>;
}
