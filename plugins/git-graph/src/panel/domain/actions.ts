import type { GitGraphMutation, GitGraphResponse } from '../../shared/protocol.js';
import type { MutationIntent } from './index.js';

type ReadData = Exclude<Extract<GitGraphResponse, { ok: true; operation: 'read' }>['data'], { jobId: string }>;
export type RefInfo = Extract<ReadData, { read: 'refs' }>['refs'][number];
export type StashInfo = Extract<ReadData, { read: 'working-tree' }>['stashes'][number];
export type GitAttention = Extract<ReadData, { read: 'status' | 'working-tree' }>['status']['attention'];

type BranchAction = 'create' | 'rename' | 'delete' | 'checkout';
type TagAction = 'create' | 'delete';
type CommitAction = 'checkout' | 'cherry-pick' | 'revert' | 'reset-soft' | 'reset-mixed' | 'reset-hard';
type RefAction = 'merge' | 'rebase';
type StashAction = 'save' | 'apply' | 'pop' | 'drop';
type RecoveryAction = 'continue' | 'abort';

const target = (action: GitGraphMutation): string => {
  if ('branch' in action) return action.branch ?? action.mutation;
  if ('commit' in action) return action.commit;
  if ('ref' in action) return action.ref;
  if ('message' in action && action.message) return action.message;
  if ('path' in action) return action.path;
  if ('name' in action) return action.name;
  if ('oldName' in action) return action.oldName;
  if ('onto' in action) return action.onto;
  return action.mutation;
};
const copy = (action: GitGraphMutation, destructive = false): MutationIntent => ({ title: action.mutation, message: `${action.mutation}: ${target(action)}`, destructive, action });
const ref = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

export function buildBranchAction(kind: BranchAction, input: { name?: string; startPoint?: string; oldName?: string; newName?: string; branch?: string }): MutationIntent | null {
  if (kind === 'create') {
    const name = ref(input.name);
    return name ? copy({ mutation: 'create-branch', name, startPoint: ref(input.startPoint) }) : null;
  }
  if (kind === 'rename') {
    const oldName = ref(input.oldName);
    const newName = ref(input.newName);
    return oldName && newName ? copy({ mutation: 'rename-branch', oldName, newName }) : null;
  }
  const branch = ref(input.branch);
  return branch ? copy(kind === 'delete' ? { mutation: 'delete-branch', branch, force: false } : { mutation: 'checkout', branch }, kind === 'delete') : null;
}

export function buildTagAction(kind: TagAction, input: { name: string; commit?: string | null }): MutationIntent | null {
  const name = ref(input.name);
  if (!name) return null;
  if (kind === 'delete') return copy({ mutation: 'delete-tag', name }, true);
  return input.commit ? copy({ mutation: 'create-tag', name, commit: input.commit }) : null;
}

export function buildCommitAction(kind: CommitAction, selectedCommit: string | null): MutationIntent | null {
  if (!selectedCommit) return null;
  if (kind === 'checkout') return copy({ mutation: 'checkout', branch: selectedCommit });
  if (kind === 'cherry-pick') return copy({ mutation: 'cherry-pick', commit: selectedCommit });
  if (kind === 'revert') return copy({ mutation: 'revert', commit: selectedCommit });
  const mode = kind.slice('reset-'.length) as 'soft' | 'mixed' | 'hard';
  return copy({ mutation: 'reset', commit: selectedCommit, mode, force: mode === 'hard' }, true);
}

export function buildRefAction(kind: RefAction, selectedRef: string): MutationIntent | null {
  const value = ref(selectedRef);
  return value ? copy(kind === 'merge' ? { mutation: 'merge', branch: value } : { mutation: 'rebase', onto: value }) : null;
}

export function buildStashAction(kind: StashAction, input: { message?: string; includeUntracked?: boolean; ref?: string }): MutationIntent | null {
  if (kind === 'save') return copy({ mutation: 'stash-create', message: ref(input.message), includeUntracked: input.includeUntracked ?? false });
  const stashRef = ref(input.ref);
  if (!stashRef) return null;
  if (kind === 'apply') return copy({ mutation: 'stash-apply', ref: stashRef });
  return copy(kind === 'pop' ? { mutation: 'stash-pop', ref: stashRef } : { mutation: 'stash-drop', ref: stashRef }, true);
}

export function buildAttentionAction(attention: GitAttention, kind: RecoveryAction): MutationIntent | null {
  if (attention === 'bisect' || !attention) return null;
  if (attention === 'merge') return copy(kind === 'continue' ? { mutation: 'merge-continue' } : { mutation: 'merge-abort' });
  if (attention === 'rebase') return copy(kind === 'continue' ? { mutation: 'rebase-continue' } : { mutation: 'rebase-abort' });
  if (attention === 'cherry-pick') return copy(kind === 'continue' ? { mutation: 'cherry-pick-continue' } : { mutation: 'cherry-pick-abort' });
  return copy(kind === 'continue' ? { mutation: 'revert-continue' } : { mutation: 'revert-abort' });
}

export function withActionCopy(intent: MutationIntent, title: string, message = intent.message): MutationIntent {
  return { ...intent, title, message };
}
