import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import type { HostClient } from '@openchamber/sdk';
import type { GitGraphServiceClient } from '../domain/index.js';
import { defaultT } from '../i18n/index.js';
import type { CommitMenuPayload } from '../popover/payload.js';
import { markMenuClosed, markMenuOpen } from '../popover/menu-state.js';
import { buildMenuBranchAction, buildMenuCheckoutAction, buildMenuCommitAction, buildMenuTagAction, menuViewFor, operationKey, outcomeView, reconcileOperation, submitMenuMutation, type DurableOperationIdentity, type MenuIntent } from './controller.js';

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
    void options.host.openPopover({ id, anchor: { x: anchor.x, y: anchor.y, width: anchor.width, height: anchor.height }, width: 248, height: 340, side: 'left', focus: true, data: options.getPayload() }).catch(() => { markMenuClosed(id); });
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
  const [reconciliationGeneration, setReconciliationGeneration] = useState(0);
  const recordRef = useRef<DurableOperationIdentity | null>(null);
  const recoveryEpoch = useRef(0);
  const hostRef = useRef(options.host); hostRef.current = options.host;
  const serviceRef = useRef(options.service); serviceRef.current = options.service;
  const settledRef = useRef(options.onSettled); settledRef.current = options.onSettled;
  useEffect(() => {
    let active = true;
    const epoch = ++recoveryEpoch.current;
    if (!options.enabled || !options.repositoryId) { setRecovery({ state: 'idle' }); return () => undefined; }
    void reconcileOperation({ repositoryId: options.repositoryId, storage: hostRef.current.storage, query: async (operationId) => { const response = await serviceRef.current.request({ version: 1, requestId: `operation:${operationId}`, repositoryId: options.repositoryId!, operation: 'operations/get', operationId }); return response.ok && response.operation === 'operations/get' ? response.data : { state: 'unknown', error: null }; }, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now: Date.now, isActive: () => active, onRecord: (record) => { if (active) recordRef.current = record; }, onProgress: (next) => { if (active) setRecovery(next); } }).then((next) => { if (!active) return; setRecovery(next); if (next.state === 'completed') settledRef.current(); }).catch(() => { if (active) setRecovery({ state: 'unknown' }); });
    return () => { active = false; if (recoveryEpoch.current === epoch) recoveryEpoch.current += 1; recordRef.current = null; };
  }, [options.enabled, options.repositoryId, options.revision, reconciliationGeneration]);
  const acknowledge = useCallback(() => {
    const record = recordRef.current;
    if (!record || (recovery.state !== 'failed' && recovery.state !== 'unknown')) return;
    const epoch = recoveryEpoch.current;
    void options.host.storage.get(operationKey(record.repositoryId), { scope: 'device' }).then(async (latest) => {
      if (recoveryEpoch.current !== epoch) return false;
      if (!latest || typeof latest !== 'object' || (latest as Partial<DurableOperationIdentity>).operationId !== record.operationId) {
        setReconciliationGeneration((generation) => generation + 1);
        return false;
      }
      await options.host.storage.delete(operationKey(record.repositoryId), { scope: 'device' });
      return true;
    }).then((deleted) => {
      if (!deleted || recoveryEpoch.current !== epoch) return;
      recordRef.current = null;
      setRecovery({ state: 'idle' });
      options.onSettled();
    }).catch(() => undefined);
  }, [options.host, options.onSettled, recovery.state]);
  return { recovery, blocked: recovery.state === 'running' || recovery.state === 'unknown', acknowledge };
}

type View = 'menu' | 'branch' | 'tag' | 'confirm' | 'pending' | 'success' | 'failure' | 'unknown' | 'conflict';
type Attention = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null;
type MenuStatus = { current: string; files: { path: string; index: string; workingDirectory: string; staged: boolean; unstaged: boolean }[]; attention: Attention };
const attentionIntent = (attention: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null, kind: 'continue' | 'abort'): MenuIntent | null => {
  const label = defaultT(kind === 'continue' ? 'gitActions.continue' : 'gitActions.abort');
  if (attention === 'merge') return { label, action: { mutation: kind === 'continue' ? 'merge-continue' : 'merge-abort' } };
  if (attention === 'rebase') return { label, action: { mutation: kind === 'continue' ? 'rebase-continue' : 'rebase-abort' } };
  if (attention === 'cherry-pick') return { label, action: { mutation: kind === 'continue' ? 'cherry-pick-continue' : 'cherry-pick-abort' } };
  if (attention === 'revert') return { label, action: { mutation: kind === 'continue' ? 'revert-continue' : 'revert-abort' } };
  return null;
};
const isCurrentAttentionIntent = (attention: Attention, intent: MenuIntent) => {
  const continueIntent = attentionIntent(attention, 'continue');
  const abortIntent = attentionIntent(attention, 'abort');
  return intent.action.mutation === continueIntent?.action.mutation || intent.action.mutation === abortIntent?.action.mutation;
};

/** Child-frame view for kind:'menu'. */
export function CommitMenuView({ host, service, directory, payload }: { host: HostClient; service: GitGraphServiceClient; directory: string; payload: CommitMenuPayload }): ReactNode {
  const t = defaultT;
  const [view, setView] = useState<View>('menu');
  const [repository, setRepository] = useState<{ id: string; snapshot: string } | null>(null);
  const [status, setStatus] = useState<MenuStatus | null>(null);
  const [intent, setIntent] = useState<MenuIntent | null>(null);
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [activeMenuItem, setActiveMenuItem] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const firstMenuItem = useRef<HTMLButtonElement>(null);
  const confirmBack = useRef<HTMLButtonElement>(null);
  const pendingStatus = useRef<HTMLParagraphElement>(null);
  const root = useRef<HTMLElement>(null);
  useEffect(() => { if (view === 'branch' || view === 'tag') input.current?.focus(); }, [view]);
  useEffect(() => { if (view === 'menu') { setActiveMenuItem(0); firstMenuItem.current?.focus(); } }, [view, Boolean(status)]);
  useEffect(() => { if (view === 'confirm') confirmBack.current?.focus(); }, [view]);
  useEffect(() => { if (view === 'pending') pendingStatus.current?.focus(); }, [view]);
  useEffect(() => { if (!root.current) return; const observer = new ResizeObserver(() => { if (root.current) void host.setHeight(Math.ceil(root.current.scrollHeight)); }); observer.observe(root.current); return () => observer.disconnect(); }, [host]);
  useEffect(() => { let active = true; void (async () => {
    const open = await service.request({ version: 1, requestId: 'menu:open', operation: 'repo/open', repositoryId: 'menu', directory });
    if (!active) return;
    if (!open.ok || open.operation !== 'repo/open') { setMessage(!open.ok ? open.error.message : t('menu.openError')); setView('failure'); return; }
    const repo = open.data;
    setRepository(repo);
    const response = await service.request({ version: 1, requestId: 'menu:status', operation: 'read', read: 'status', repositoryId: repo.id, snapshot: repo.snapshot });
    if (!active) return;
    if (response.ok && response.operation === 'read' && response.data.read === 'status') { setStatus(response.data.status); setView(menuViewFor(response.data.status)); return; }
    setMessage(!response.ok ? response.error.message : t('menu.openError'));
    setView('failure');
  })().catch((error) => { if (active) { setMessage(error instanceof Error ? error.message : t('menu.openError')); setView('failure'); } }); return () => { active = false; }; }, [directory, service]);
  const review = async (next: MenuIntent) => {
    if (!repository) return;
    const refreshed = await service.request({ version: 1, requestId: `menu:refresh:${newId()}`, operation: 'refresh', repositoryId: repository.id, snapshot: repository.snapshot });
    if (!refreshed.ok || refreshed.operation !== 'refresh') { setMessage(!refreshed.ok ? refreshed.error.message : t('menu.repoChanged')); setView('failure'); return; }
    const snapshot = refreshed.data.snapshot;
    const statusResult = await service.request({ version: 1, requestId: `menu:status:${newId()}`, operation: 'read', read: 'status', repositoryId: repository.id, snapshot });
    if (!statusResult.ok || statusResult.operation !== 'read' || statusResult.data.read !== 'status') { setMessage(!statusResult.ok ? statusResult.error.message : t('menu.repoChanged')); setView('failure'); return; }
    setRepository({ ...repository, snapshot });
    setStatus(statusResult.data.status);
    const isRecoveryIntent = next.action.mutation.endsWith('-continue') || next.action.mutation.endsWith('-abort');
    if ((statusResult.data.status.attention || isRecoveryIntent) && !isCurrentAttentionIntent(statusResult.data.status.attention, next)) { setView(menuViewFor(statusResult.data.status)); return; }
    setIntent(next); setView('confirm');
  };
  const submit = async () => {
    if (!repository || !intent) return;
    setView('pending');
    const operationId = newId();
    const cleanupKnownOutcome = async () => {
      try {
        const latest = await host.storage.get(operationKey(repository.id), { scope: 'device' });
        if (latest && typeof latest === 'object' && (latest as Partial<DurableOperationIdentity>).operationId === operationId) await host.storage.delete(operationKey(repository.id), { scope: 'device' });
      } catch { /* A known service outcome must remain known when cleanup is unavailable. */ }
    };
    try {
      const response = await submitMenuMutation({ storage: host.storage, service, directory, repositoryId: repository.id, expectedSnapshot: repository.snapshot, intent, confirmHardReset: intent.action.mutation === 'reset' && intent.action.mode === 'hard', operationId, now: Date.now });
      const mapped = outcomeView(response.ok ? { ok: true } : { ok: false, code: response.error.code, message: response.error.message });
      if (mapped.view === 'unknown') { setView('unknown'); return; }
      await cleanupKnownOutcome();
      if (mapped.view === 'failure') { setMessage(t(mapped.messageKey ?? 'menu.errorTitle')); setView('failure'); return; }
      if (!response.ok || response.operation !== 'mutate') {
        const code = !response.ok ? response.error.code : 'internal';
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
        setMessage(t('menu.errorTitle'));
        setView('failure');
        return;
      }
      if ('result' in response.data && response.data.result.state === 'conflict') { setView('conflict'); return; }
      setView('success'); window.setTimeout(() => { void host.close(); }, 1200);
    } catch (error) { const message = error instanceof Error ? error.message : ''; setMessage(message.startsWith('not-submitted:') ? t('menu.notSubmitted') : message || t('menu.unknownOutcome')); setView(message.startsWith('not-submitted:') ? 'failure' : 'unknown'); }
  };
  // The popover frame is sandboxed without allow-forms, so a <form> submit never fires; submit explicitly.
  const submitName = () => choose(view === 'branch' ? buildMenuBranchAction(name, payload.commit) : buildMenuTagAction(name, payload.commit));
  const choose = (next: MenuIntent | null) => { if (next) void review(next).catch((error) => { setMessage(error instanceof Error ? error.message : t('menu.errorTitle')); setView('failure'); }); };
  const dirty = status?.files.length ?? 0;
  const moveMenuFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' || (current < 0 && event.key === 'ArrowDown') ? 0 : event.key === 'End' || current < 0 ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    setActiveMenuItem(next);
    items[next]?.focus();
  };
  return <section ref={root} id="git-commit-menu" className="gcm" aria-label={t('menu.openActions', { subject: payload.subject })}>
    {view === 'menu' && !status && <p data-commit-menu-view="loading" role="status">{t('workspace.loading')}</p>}
    {view === 'menu' && status && <><header className="gcm-header" aria-hidden="true"><span className="gcm-header-subject">{payload.subject}</span><code className="gcm-header-sha">{payload.commit.slice(0, 7)}</code></header><div className="gcm-menu" data-commit-menu-view="menu" role="menu" aria-label={t('menu.openActions', { subject: payload.subject })} onKeyDown={moveMenuFocus} onPointerMove={(event) => { const item = (event.target as Element).closest<HTMLButtonElement>('[role="menuitem"]'); if (item && item !== document.activeElement) item.focus({ preventScroll: true }); }}><div id="gcm-grp-nav" className="gcm-group" role="group"><button ref={firstMenuItem} role="menuitem" data-commit-menu-item="copy-sha" tabIndex={activeMenuItem === 0 ? 0 : -1} onFocus={() => setActiveMenuItem(0)} onClick={() => void host.writeClipboard(payload.commit)}>{t('menu.copySha')}</button><button role="menuitem" data-commit-menu-item="checkout" tabIndex={activeMenuItem === 1 ? 0 : -1} onFocus={() => setActiveMenuItem(1)} onClick={() => choose(buildMenuCheckoutAction(payload.commit, payload.branches))}>{t('menu.checkout')}</button></div><div className="gcm-sep" role="separator" /><div id="gcm-grp-ref" className="gcm-group" role="group"><button role="menuitem" data-commit-menu-item="create-branch" tabIndex={activeMenuItem === 2 ? 0 : -1} onFocus={() => setActiveMenuItem(2)} onClick={() => { setName(''); setView('branch'); }}>{t('gitActions.createBranch')}…</button><button role="menuitem" data-commit-menu-item="create-tag" tabIndex={activeMenuItem === 3 ? 0 : -1} onFocus={() => setActiveMenuItem(3)} onClick={() => { setName(''); setView('tag'); }}>{t('gitActions.createTag')}…</button></div><div className="gcm-sep" role="separator" /><div id="gcm-grp-history" className="gcm-group" role="group"><button role="menuitem" data-commit-menu-item="cherry-pick" tabIndex={activeMenuItem === 4 ? 0 : -1} onFocus={() => setActiveMenuItem(4)} onClick={() => choose(buildMenuCommitAction('cherry-pick', payload.commit))}>{t('gitActions.cherryPick')}</button><button role="menuitem" data-commit-menu-item="revert" tabIndex={activeMenuItem === 5 ? 0 : -1} onFocus={() => setActiveMenuItem(5)} onClick={() => choose(buildMenuCommitAction('revert', payload.commit))}>{t('gitActions.revert')}</button><button role="menuitem" data-commit-menu-item="merge" tabIndex={activeMenuItem === 6 ? 0 : -1} onFocus={() => setActiveMenuItem(6)} onClick={() => choose({ label: t('gitActions.merge'), action: { mutation: 'merge', branch: payload.commit } })}>{t('menu.mergeIntoCurrent')}</button><button role="menuitem" data-commit-menu-item="rebase" tabIndex={activeMenuItem === 7 ? 0 : -1} onFocus={() => setActiveMenuItem(7)} onClick={() => choose({ label: t('gitActions.rebase'), action: { mutation: 'rebase', onto: payload.commit } })}>{t('menu.rebaseCurrentOnto')}</button></div><div className="gcm-sep" role="separator" /><div id="gcm-grp-reset" className="gcm-group" role="group" aria-labelledby="gcm-reset-label"><span id="gcm-reset-label" className="gcm-group-label" aria-hidden="true">{t('menu.resetCurrent')}</span>{(['soft', 'mixed', 'hard'] as const).map((mode, index) => <button key={mode} role="menuitem" data-commit-menu-item={`reset-${mode}`} className={mode === 'hard' ? 'gcm-item--destructive' : undefined} tabIndex={activeMenuItem === index + 8 ? 0 : -1} onFocus={() => setActiveMenuItem(index + 8)} onClick={() => choose(buildMenuCommitAction(`reset-${mode}`, payload.commit))}>{t(`gitActions.reset${mode[0]!.toUpperCase()}${mode.slice(1)}`)}</button>)}</div></div></>}
    {(view === 'branch' || view === 'tag') && <div className="gcm-view" data-commit-menu-view={view} role="group" aria-label={t(view === 'branch' ? 'gitActions.createBranch' : 'gitActions.createTag')}><h2 className="gcm-view-title">{t(view === 'branch' ? 'gitActions.createBranch' : 'gitActions.createTag')}</h2><input className="gcm-input" ref={input} aria-label={t(view === 'branch' ? 'gitActions.branchName' : 'gitActions.tagName')} value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submitName(); } }} required /><footer className="gcm-footer" data-commit-menu-footer><button className="gcm-btn" data-variant="secondary" type="button" onClick={() => setView('menu')}>{t('menu.back')}</button><button className="gcm-btn" data-variant="primary" type="button" disabled={!name.trim()} onClick={submitName}>{t(view === 'branch' ? 'gitActions.createBranch' : 'gitActions.createTag')}</button></footer></div>}
    {view === 'confirm' && intent && <div className="gcm-view" data-commit-menu-view="confirm"><h2 className="gcm-view-title">{intent.label}</h2><p className="gcm-view-body">{t('menu.reviewStatus', { branch: status?.current || t('menu.detached'), count: dirty })}</p>{intent.action.mutation === 'reset' && intent.action.mode === 'hard' && dirty > 0 && <p className="gcm-view-body gcm-view-body--warn">{t('menu.hardResetWarning', { count: dirty })}</p>}<footer className="gcm-footer" data-commit-menu-footer><button ref={confirmBack} className="gcm-btn" data-variant="secondary" onClick={() => setView('menu')}>{t('menu.back')}</button><button className="gcm-btn" data-variant={intent.action.mutation === 'reset' && intent.action.mode === 'hard' ? 'destructive' : 'primary'} onClick={() => void submit()}>{intent.label}</button></footer></div>}
    {view === 'pending' && <p ref={pendingStatus} tabIndex={-1} data-commit-menu-view="pending" role="status">{t('menu.pending')}</p>}
    {view === 'success' && <p data-commit-menu-view="success" role="status">{t('menu.successBody', { title: intent?.label ?? '' })}</p>}
    {view === 'failure' && <div className="gcm-view" data-commit-menu-view="failure" role="alert"><p className="gcm-view-body">{message}</p><footer className="gcm-footer" data-commit-menu-footer><button className="gcm-btn" data-variant="secondary" onClick={() => { if (status) setView('menu'); else void host.close(); }}>{t(status ? 'menu.back' : 'menu.close')}</button></footer></div>}
    {view === 'unknown' && <div className="gcm-view" data-commit-menu-view="unknown" role="alert"><h2 className="gcm-view-title">{t('menu.unknownOutcome')}</h2><p className="gcm-view-body">{message}</p><footer className="gcm-footer" data-commit-menu-footer><button className="gcm-btn" data-variant="secondary" onClick={() => void host.close()}>{t('menu.close')}</button></footer></div>}
    {view === 'conflict' && <div className="gcm-view" data-commit-menu-view="conflict" role="alert"><h2 className="gcm-view-title">{t('menu.conflictTitle')}</h2><p className="gcm-view-body">{t('menu.conflictBody')}</p><footer className="gcm-footer" data-commit-menu-footer>{attentionIntent(status?.attention ?? null, 'continue') ? <><button className="gcm-btn" data-variant="secondary" onClick={() => choose(attentionIntent(status?.attention ?? null, 'abort'))}>{t('gitActions.abort')}</button><button className="gcm-btn" data-variant="primary" onClick={() => choose(attentionIntent(status?.attention ?? null, 'continue'))}>{t('gitActions.continue')}</button></> : <><p className="gcm-view-body">{t('menu.conflictUnavailable')}</p><button className="gcm-btn" data-variant="secondary" onClick={() => void host.close()}>{t('menu.close')}</button></>}</footer></div>}
  </section>;
}
