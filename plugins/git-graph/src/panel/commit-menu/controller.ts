import type { HostClient } from '@openchamber/sdk';
import type { GitGraphMutation } from '../../shared/protocol.js';
import type { GitGraphServiceClient, ResolvedGitGraphResponse } from '../domain/index.js';
import { defaultT } from '../i18n/index.js';

export type MenuIntent = { label: string; action: GitGraphMutation };
export type MenuCommitAction = 'checkout' | 'cherry-pick' | 'revert' | 'reset-soft' | 'reset-mixed' | 'reset-hard';
export type DurableOperation = {
  v: 1;
  directory: string;
  repositoryId: string;
  operationId: string;
  label: string;
  expectedSnapshot: string;
  action: GitGraphMutation;
  createdAt: number;
};
export type RecoveredOperationState = { state: 'running' } | { state: 'completed' } | { state: 'failed'; message: string } | { state: 'unknown' };
export type ReconcileState = RecoveredOperationState | { state: 'idle' };
type OperationQuery = { state: 'running' | 'completed' | 'failed' | 'unknown' | 'absent'; error: { message: string } | null };

export const recoveryStateForOperation = (state: 'running' | 'completed' | 'failed' | 'unknown' | 'absent', message?: string | null): RecoveredOperationState => {
  if (state === 'running') return { state: 'running' };
  if (state === 'completed') return { state: 'completed' };
  if (state === 'failed') return { state: 'failed', message: message ?? 'Operation failed' };
  return { state: 'unknown' };
};

export const operationKey = (repositoryId: string) => `git-graph:op:${repositoryId}`;

/** Pure owner reconciliation seam. It only reads/deletes durable records and queries operation status. */
export async function reconcileOperation(options: { repositoryId: string; storage: Pick<HostClient['storage'], 'get' | 'delete'>; query(operationId: string): Promise<OperationQuery>; sleep(ms: number): Promise<void>; now(): number; isActive(): boolean }): Promise<ReconcileState> {
  const started = options.now();
  for (let poll = 0; options.isActive() && options.now() - started < 600_000; poll += 1) {
    const record = await options.storage.get(operationKey(options.repositoryId), { scope: 'device' });
    if (!record || typeof record !== 'object') return { state: 'idle' };
    const value = record as Partial<DurableOperation>;
    if (value.repositoryId !== options.repositoryId || !value.operationId) return { state: 'idle' };
    const result = await options.query(value.operationId);
    if (result.state === 'running') { await options.sleep(Math.min(500 * (2 ** Math.min(poll, 4)), 5000)); continue; }
    if (result.state === 'completed') {
      const latest = await options.storage.get(operationKey(options.repositoryId), { scope: 'device' });
      if (latest && typeof latest === 'object' && (latest as Partial<DurableOperation>).operationId !== value.operationId) {
        const replacement = latest as Partial<DurableOperation>;
        if (replacement.repositoryId === options.repositoryId && replacement.operationId) return recoveryStateForOperation((await options.query(replacement.operationId)).state);
      }
      if (latest && typeof latest === 'object' && (latest as Partial<DurableOperation>).operationId === value.operationId) await options.storage.delete(operationKey(options.repositoryId), { scope: 'device' });
      return { state: 'completed' };
    }
    return recoveryStateForOperation(result.state, result.error?.message);
  }
  return { state: 'unknown' };
}

export const outcomeView = (value: { ok: boolean; code?: string; message?: string } | Error): { view: 'success' | 'failure' | 'unknown' | 'conflict' | 'not-submitted'; messageKey?: string } => {
  if (value instanceof Error) return { view: 'not-submitted', messageKey: 'menu.notSubmitted' };
  if (value.ok) return { view: 'success' };
  if (value.code === 'snapshot-conflict') return { view: 'failure', messageKey: 'menu.repoChanged' };
  if (value.code === 'conflict') return { view: 'conflict' };
  if (value.code === 'timeout-unknown' || value.code === 'job-lost') return { view: 'unknown' };
  return { view: 'failure', messageKey: value.message ?? 'menu.errorTitle' };
};
export const menuViewFor = (status: { attention: string | null } | null): 'menu' | 'conflict' => status?.attention ? 'conflict' : 'menu';

export function buildMenuCommitAction(kind: MenuCommitAction, commit: string): MenuIntent | null {
  if (!commit) return null;
  if (kind === 'checkout') return { label: defaultT('gitActions.checkoutDetached'), action: { mutation: 'checkout', branch: commit } };
  if (kind === 'cherry-pick') return { label: defaultT('gitActions.cherryPick'), action: { mutation: 'cherry-pick', commit } };
  if (kind === 'revert') return { label: defaultT('gitActions.revert'), action: { mutation: 'revert', commit } };
  const mode = kind.slice('reset-'.length) as 'soft' | 'mixed' | 'hard';
  return { label: defaultT(`gitActions.reset${mode[0]!.toUpperCase()}${mode.slice(1)}`), action: { mutation: 'reset', commit, mode, force: false } };
}

export function buildMenuCheckoutAction(commit: string, branches: string[]): MenuIntent {
  const branch = branches.length === 1 ? branches[0]! : commit;
  return { label: branches.length === 1 ? defaultT('menu.checkoutBranch', { branch }) : defaultT('gitActions.checkoutDetached'), action: { mutation: 'checkout', branch } };
}

export function buildMenuBranchAction(name: string, commit: string): MenuIntent | null {
  const trimmed = name.trim();
  return trimmed ? { label: defaultT('gitActions.createBranch'), action: { mutation: 'create-branch', name: trimmed, startPoint: commit } } : null;
}

export function buildMenuTagAction(name: string, commit: string): MenuIntent | null {
  const trimmed = name.trim();
  return trimmed ? { label: defaultT('gitActions.createTag'), action: { mutation: 'create-tag', name: trimmed, commit } } : null;
}

const confirmedAction = (intent: MenuIntent, confirmHardReset: boolean): GitGraphMutation => {
  if (intent.action.mutation !== 'reset' || intent.action.mode !== 'hard' || !confirmHardReset) return intent.action;
  return { ...intent.action, force: true };
};

export async function submitMenuMutation(options: {
  storage: Pick<HostClient['storage'], 'get' | 'set'>;
  service: GitGraphServiceClient;
  directory: string;
  repositoryId: string;
  expectedSnapshot: string;
  intent: MenuIntent;
  confirmHardReset: boolean;
  operationId: string;
  now(): number;
}): Promise<ResolvedGitGraphResponse> {
  let existing: unknown;
  try { existing = await options.storage.get(operationKey(options.repositoryId), { scope: 'device' }); } catch (error) { throw new Error(`not-submitted:${error instanceof Error ? error.message : ''}`); }
  if (existing) throw new Error(defaultT('menu.unresolvedOperation'));
  const action = confirmedAction(options.intent, options.confirmHardReset);
  const record: DurableOperation = {
    v: 1, directory: options.directory, repositoryId: options.repositoryId, operationId: options.operationId,
    label: options.intent.label, expectedSnapshot: options.expectedSnapshot, action, createdAt: options.now(),
  };
  // Await persistence before the write: a disposed popover must remain recoverable.
  try { await options.storage.set(operationKey(options.repositoryId), record, { scope: 'device' }); } catch (error) { throw new Error(`not-submitted:${error instanceof Error ? error.message : ''}`); }
  return options.service.request({
    version: 1, requestId: `mutate:${options.operationId}`, repositoryId: options.repositoryId,
    operation: 'mutate', snapshot: options.expectedSnapshot, expectedSnapshot: options.expectedSnapshot,
    operationId: options.operationId, action,
  });
}
