import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import type { HostClient } from '@openchamber/sdk';
import type { GitGraphServiceClient } from '../domain/index.js';
import { defaultT } from '../i18n/index.js';
import type { CommitMenuPayload } from '../popover/payload.js';
import { markMenuClosed, markMenuOpen } from '../popover/menu-state.js';
import { buildMenuBranchAction, buildMenuCheckoutAction, buildMenuCommitAction, buildMenuTagAction, menuViewFor, operationKey, outcomeView, reconcileOperation, submitMenuMutation, type DurableOperation, type MenuIntent } from './controller.js';

const newId = () => `menu:${crypto.randomUUID()}`;
/** Host popover IDs allow only [A-Za-z0-9_-]; the owner uses this prefix to recognize menu closes. */
export const MENU_POPOVER_PREFIX = 'menu-';
const popoverId = () => `${MENU_POPOVER_PREFIX}${crypto.randomUUID()}`;

/** Row handlers that open the focused action popover (context menu, Shift+F10, ContextMenu key). */
export function useCommitMenuTrigger(options: { host: HostClient; enabled: boolean; getPayload: () => CommitMenuPayload }): { onContextMenu(event: MouseEvent<HTMLElement>): void; onKeyDown(event: KeyboardEvent<HTMLElement>): void } {
  const open = useCallback((target: HTMLElement) => {
    if (!options.enabled) return;
    const anchor = target.getBoundingClientRect();
    const id = popoverId();
    markMenuOpen(id);
    void options.host.openPopover({ id, anchor: { x: anchor.x, y: anchor.y, width: anchor.width, height: anchor.height }, width: 320, height: 420, side: 'left', focus: true, data: options.getPayload() }).catch(() => { markMenuClosed(id); });
  }, [options]);
  return {
    onContextMenu: (event) => { if (!options.enabled) return; event.preventDefault(); open(event.currentTarget); },
    onKeyDown: (event) => {
      if (!options.enabled || (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey))) return;
      event.preventDefault();
      open(event.currentTarget);
    },
  };
}

export type OperationRecoveryState = { state: 'idle' } | { state: 'running' } | { state: 'completed' } | { state: 'failed'; message: string } | { state: 'unknown' };


/** Owner-side reconciliation only queries operation state; it never recreates or resubmits a write. */
export function useOperationRecovery(options: { host: HostClient; service: GitGraphServiceClient; repositoryId: string | null; enabled: boolean; revision: number; onSettled(): void }): { recovery: OperationRecoveryState; blocked: boolean; acknowledge(): void } {
  const [recovery, setRecovery] = useState<OperationRecoveryState>({ state: 'idle' });
  const recordRef = useRef<DurableOperation | null>(null);
  const hostRef = useRef(options.host); hostRef.current = options.host;
  const serviceRef = useRef(options.service); serviceRef.current = options.service;
  const settledRef = useRef(options.onSettled); settledRef.current = options.onSettled;
  useEffect(() => {
    let active = true;
    if (!options.enabled || !options.repositoryId) { setRecovery({ state: 'idle' }); return () => undefined; }
    void reconcileOperation({ repositoryId: options.repositoryId, storage: hostRef.current.storage, query: async (operationId) => { const response = await serviceRef.current.request({ version: 1, requestId: `operation:${operationId}`, repositoryId: options.repositoryId!, operation: 'operations/get', operationId }); return response.ok && response.operation === 'operations/get' ? response.data : { state: 'unknown', error: null }; }, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now: Date.now, isActive: () => active }).then((next) => { if (!active) return; setRecovery(next); if (next.state === 'completed') settledRef.current(); }).catch(() => { if (active) setRecovery({ state: 'unknown' }); });
    return () => { active = false; recordRef.current = null; };
  }, [options.enabled, options.repositoryId, options.revision]);
  const acknowledge = useCallback(() => {
    const record = recordRef.current;
    if (!record || (recovery.state !== 'failed' && recovery.state !== 'unknown')) return;
    void options.host.storage.get(operationKey(record.repositoryId), { scope: 'device' }).then((latest) => {
      if (!latest || typeof latest !== 'object' || (latest as Partial<DurableOperation>).operationId !== record.operationId) return;
      return options.host.storage.delete(operationKey(record.repositoryId), { scope: 'device' });
    }).then(() => { recordRef.current = null; setRecovery({ state: 'idle' }); options.onSettled(); }).catch(() => undefined);
  }, [options.host, options.onSettled, recovery.state]);
  return { recovery, blocked: recovery.state === 'running' || recovery.state === 'unknown', acknowledge };
}

type View = 'menu' | 'branch' | 'tag' | 'confirm' | 'pending' | 'success' | 'failure' | 'unknown' | 'conflict';
const attentionIntent = (attention: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null, kind: 'continue' | 'abort'): MenuIntent | null => {
  const label = defaultT(kind === 'continue' ? 'gitActions.continue' : 'gitActions.abort');
  if (attention === 'merge') return { label, action: { mutation: kind === 'continue' ? 'merge-continue' : 'merge-abort' } };
  if (attention === 'rebase') return { label, action: { mutation: kind === 'continue' ? 'rebase-continue' : 'rebase-abort' } };
  if (attention === 'cherry-pick') return { label, action: { mutation: kind === 'continue' ? 'cherry-pick-continue' : 'cherry-pick-abort' } };
  if (attention === 'revert') return { label, action: { mutation: kind === 'continue' ? 'revert-continue' : 'revert-abort' } };
  return null;
};

/** Child-frame view for kind:'menu'. */
export function CommitMenuView({ host, service, directory, payload }: { host: HostClient; service: GitGraphServiceClient; directory: string; payload: CommitMenuPayload }): ReactNode {
  const t = defaultT;
  const [view, setView] = useState<View>('menu');
  const [repository, setRepository] = useState<{ id: string; snapshot: string } | null>(null);
  const [status, setStatus] = useState<{ current: string; files: unknown[]; attention: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null } | null>(null);
  const [intent, setIntent] = useState<MenuIntent | null>(null);
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const firstMenuItem = useRef<HTMLButtonElement>(null);
  const confirmBack = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLElement>(null);
  useEffect(() => { if (view === 'branch' || view === 'tag') input.current?.focus(); }, [view]);
  useEffect(() => { if (view === 'menu') firstMenuItem.current?.focus(); }, [view]);
  useEffect(() => { if (view === 'confirm') confirmBack.current?.focus(); }, [view]);
  useEffect(() => { if (!root.current) return; const observer = new ResizeObserver(() => { if (root.current) void host.setHeight(Math.ceil(root.current.scrollHeight)); }); observer.observe(root.current); return () => observer.disconnect(); }, [host]);
  useEffect(() => { let active = true; void (async () => {
    const open = await service.request({ version: 1, requestId: 'menu:open', operation: 'repo/open', repositoryId: 'menu', directory });
    if (!open.ok || open.operation !== 'repo/open' || !active) { setMessage(!open.ok ? open.error.message : t('menu.openError')); setView('failure'); return; }
    const repo = open.data;
    setRepository(repo);
    const response = await service.request({ version: 1, requestId: 'menu:status', operation: 'read', read: 'status', repositoryId: repo.id, snapshot: repo.snapshot });
    if (active && response.ok && response.operation === 'read' && response.data.read === 'status') { setStatus(response.data.status); setView(menuViewFor(response.data.status)); }
  })(); return () => { active = false; }; }, [directory, service]);
  const review = async (next: MenuIntent) => {
    if (!repository) return;
    const refreshed = await service.request({ version: 1, requestId: `menu:refresh:${newId()}`, operation: 'refresh', repositoryId: repository.id, snapshot: repository.snapshot });
    if (!refreshed.ok || refreshed.operation !== 'refresh') { setMessage(!refreshed.ok ? refreshed.error.message : t('menu.repoChanged')); setView('failure'); return; }
    const snapshot = refreshed.data.snapshot;
    const statusResult = await service.request({ version: 1, requestId: `menu:status:${newId()}`, operation: 'read', read: 'status', repositoryId: repository.id, snapshot });
    if (!statusResult.ok || statusResult.operation !== 'read' || statusResult.data.read !== 'status') { setMessage(!statusResult.ok ? statusResult.error.message : t('menu.repoChanged')); setView('failure'); return; }
    setRepository({ ...repository, snapshot });
    setStatus(statusResult.data.status);
    if (menuViewFor(statusResult.data.status) === 'conflict') { setView('conflict'); return; }
    setIntent(next); setView('confirm');
  };
  const submit = async () => {
    if (!repository || !intent) return;
    setView('pending');
    try {
      const response = await submitMenuMutation({ storage: host.storage, service, directory, repositoryId: repository.id, expectedSnapshot: repository.snapshot, intent, confirmHardReset: intent.action.mutation === 'reset' && intent.action.mode === 'hard', operationId: newId(), now: Date.now });
      const mapped = outcomeView(response.ok ? { ok: true } : { ok: false, code: response.error.code, message: response.error.message });
      if (mapped.view === 'unknown') { setView('unknown'); return; }
      if (mapped.view === 'failure') { setMessage(t(mapped.messageKey ?? 'menu.errorTitle')); setView('failure'); return; }
      if (!response.ok || response.operation !== 'mutate') {
        const code = !response.ok ? response.error.code : 'internal';
        const error = !response.ok ? response.error.message : t('menu.errorTitle');
        if (code !== 'timeout-unknown' && code !== 'job-lost') await host.storage.delete(operationKey(repository.id), { scope: 'device' });
        if (code === 'conflict') {
          const refreshed = await service.request({ version: 1, requestId: `menu:conflict-refresh:${newId()}`, operation: 'refresh', repositoryId: repository.id, snapshot: repository.snapshot });
          if (refreshed.ok && refreshed.operation === 'refresh') {
            setRepository({ ...repository, snapshot: refreshed.data.snapshot });
            const current = await service.request({ version: 1, requestId: `menu:conflict:${newId()}`, operation: 'read', read: 'status', repositoryId: repository.id, snapshot: refreshed.data.snapshot });
            if (current.ok && current.operation === 'read' && current.data.read === 'status') setStatus(current.data.status);
          }
          setView('conflict');
          return;
        }
        setMessage(code === 'snapshot-conflict' ? t('menu.repoChanged') : error);
        setView(code === 'timeout-unknown' || code === 'job-lost' ? 'unknown' : 'failure');
        return;
      }
      if ('result' in response.data && response.data.result.state === 'conflict') { await host.storage.delete(operationKey(repository.id), { scope: 'device' }); setView('conflict'); return; }
      await host.storage.delete(operationKey(repository.id), { scope: 'device' });
      setView('success'); window.setTimeout(() => { void host.close(); }, 1200);
    } catch (error) { const message = error instanceof Error ? error.message : ''; setMessage(message.startsWith('not-submitted:') ? t('menu.notSubmitted') : message || t('menu.unknownOutcome')); setView(message.startsWith('not-submitted:') ? 'failure' : 'unknown'); }
  };
  // The popover frame is sandboxed without allow-forms, so a <form> submit never fires; submit explicitly.
  const submitName = () => choose(view === 'branch' ? buildMenuBranchAction(name, payload.commit) : buildMenuTagAction(name, payload.commit));
  const choose = (next: MenuIntent | null) => { if (next) void review(next).catch((error) => { setMessage(error instanceof Error ? error.message : t('menu.errorTitle')); setView('failure'); }); };
  const dirty = status?.files.length ?? 0;
  return <section ref={root} id="git-commit-menu" className="git-commit-menu" aria-label="Git actions">
    {view === 'menu' && <div data-commit-menu-view="menu" role="group" aria-label={t('menu.openActions', { subject: payload.subject })}><h2>{payload.subject}</h2><button ref={firstMenuItem} onClick={() => void host.writeClipboard(payload.commit)}>{t('menu.copySha')}</button><button onClick={() => choose(buildMenuCheckoutAction(payload.commit, payload.branches))}>{t('menu.checkout')}</button><button onClick={() => { setName(''); setView('branch'); }}>{t('gitActions.createBranch')}…</button><button onClick={() => { setName(''); setView('tag'); }}>{t('gitActions.createTag')}…</button><button onClick={() => choose(buildMenuCommitAction('cherry-pick', payload.commit))}>{t('gitActions.cherryPick')}</button><button onClick={() => choose(buildMenuCommitAction('revert', payload.commit))}>{t('gitActions.revert')}</button><button onClick={() => choose({ label: t('gitActions.merge'), action: { mutation: 'merge', branch: payload.commit } })}>{t('menu.mergeIntoCurrent')}</button><button onClick={() => choose({ label: t('gitActions.rebase'), action: { mutation: 'rebase', onto: payload.commit } })}>{t('menu.rebaseCurrentOnto')}</button><fieldset><legend>{t('menu.resetCurrent')}</legend>{(['soft', 'mixed', 'hard'] as const).map((mode) => <button key={mode} onClick={() => choose(buildMenuCommitAction(`reset-${mode}`, payload.commit))}>{t(`gitActions.reset${mode[0]!.toUpperCase()}${mode.slice(1)}`)}</button>)}</fieldset></div>}
    {(view === 'branch' || view === 'tag') && <div data-commit-menu-view={view} role="group" aria-label={t(view === 'branch' ? 'gitActions.createBranch' : 'gitActions.createTag')}><h2>{t(view === 'branch' ? 'gitActions.createBranch' : 'gitActions.createTag')}</h2><input ref={input} aria-label={t(view === 'branch' ? 'gitActions.branchName' : 'gitActions.tagName')} value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submitName(); } }} required /><button type="button" onClick={() => setView('menu')}>{t('menu.back')}</button><button type="button" disabled={!name.trim()} onClick={submitName}>{t(view === 'branch' ? 'gitActions.createBranch' : 'gitActions.createTag')}</button></div>}
    {view === 'confirm' && intent && <div data-commit-menu-view="confirm"><h2>{intent.label}</h2><p>{t('menu.reviewStatus', { branch: status?.current || t('menu.detached'), count: dirty })}</p>{intent.action.mutation === 'reset' && intent.action.mode === 'hard' && dirty > 0 && <p>{t('menu.hardResetWarning', { count: dirty })}</p>}<button ref={confirmBack} onClick={() => setView('menu')}>{t('menu.back')}</button><button onClick={() => void submit()}>{intent.label}</button></div>}
    {view === 'pending' && <p data-commit-menu-view="pending" aria-busy="true">{t('menu.pending')}</p>}
    {view === 'success' && <p data-commit-menu-view="success">{t('menu.successBody', { title: intent?.label ?? '' })}</p>}
    {view === 'failure' && <div data-commit-menu-view="failure" role="alert"><p>{message}</p><button onClick={() => setView('menu')}>{t('menu.back')}</button></div>}
    {view === 'unknown' && <div data-commit-menu-view="unknown" role="alert"><p>{t('menu.unknownOutcome')} {message}</p><button onClick={() => void host.close()}>{t('menu.close')}</button></div>}
    {view === 'conflict' && <div data-commit-menu-view="conflict" role="alert"><h2>{t('menu.conflictTitle')}</h2><p>{t('menu.conflictBody')}</p>{attentionIntent(status?.attention ?? null, 'continue') ? <><button onClick={() => choose(attentionIntent(status?.attention ?? null, 'continue'))}>{t('gitActions.continue')}</button><button onClick={() => choose(attentionIntent(status?.attention ?? null, 'abort'))}>{t('gitActions.abort')}</button></> : <p>{t('menu.conflictUnavailable')}</p>}</div>}
  </section>;
}
