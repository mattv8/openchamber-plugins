import { describe, expect, test } from 'bun:test';
import {
  buildAttentionAction,
  buildBranchAction,
  buildCommitAction,
  buildRefAction,
  buildStashAction,
  buildTagAction,
} from '../../src/panel/domain/actions.js';

const commit = 'a'.repeat(40);

describe('branch actions', () => {
  test('builds each branch mutation from non-empty refs', () => {
    expect(buildBranchAction('create', { name: ' feature ', startPoint: ' main ' })?.action).toEqual({ mutation: 'create-branch', name: 'feature', startPoint: 'main' });
    expect(buildBranchAction('rename', { oldName: ' feature ', newName: ' next ' })?.action).toEqual({ mutation: 'rename-branch', oldName: 'feature', newName: 'next' });
    expect(buildBranchAction('delete', { branch: ' feature ' })?.action).toEqual({ mutation: 'delete-branch', branch: 'feature', force: false });
    expect(buildBranchAction('checkout', { branch: ' feature ' })?.action).toEqual({ mutation: 'checkout', branch: 'feature' });
  });

  test('does not build branch actions with empty required names', () => {
    expect(buildBranchAction('create', { name: '  ', startPoint: '' })).toBeNull();
    expect(buildBranchAction('rename', { oldName: 'main', newName: '  ' })).toBeNull();
    expect(buildBranchAction('delete', { branch: '' })).toBeNull();
    expect(buildBranchAction('checkout', { branch: '' })).toBeNull();
  });
});

describe('tag actions', () => {
  test('builds tag creation and deletion', () => {
    expect(buildTagAction('create', { name: ' v1 ', commit })?.action).toEqual({ mutation: 'create-tag', name: 'v1', commit });
    expect(buildTagAction('delete', { name: ' v1 ' })?.action).toEqual({ mutation: 'delete-tag', name: 'v1' });
  });

  test('requires a tag name and selected commit', () => {
    expect(buildTagAction('create', { name: 'v1', commit: null })).toBeNull();
    expect(buildTagAction('delete', { name: ' ' })).toBeNull();
  });
});

describe('selected commit actions', () => {
  test('builds checkout, cherry-pick, revert, and reset actions', () => {
    expect(buildCommitAction('checkout', commit)?.action).toEqual({ mutation: 'checkout', branch: commit });
    expect(buildCommitAction('cherry-pick', commit)?.action).toEqual({ mutation: 'cherry-pick', commit });
    expect(buildCommitAction('revert', commit)?.action).toEqual({ mutation: 'revert', commit });
    expect(buildCommitAction('reset-hard', commit)?.action).toEqual({ mutation: 'reset', commit, mode: 'hard', force: true });
  });

  test('does not build commit actions without a selection', () => {
    expect(buildCommitAction('reset-soft', null)).toBeNull();
  });
});

describe('ref, stash, and recovery actions', () => {
  test('builds merge/rebase and all stash actions', () => {
    expect(buildRefAction('merge', ' topic ')?.action).toEqual({ mutation: 'merge', branch: 'topic' });
    expect(buildRefAction('rebase', ' main ')?.action).toEqual({ mutation: 'rebase', onto: 'main' });
    expect(buildStashAction('save', { message: ' WIP ', includeUntracked: true })?.action).toEqual({ mutation: 'stash-create', message: 'WIP', includeUntracked: true });
    expect(buildStashAction('apply', { ref: ' stash@{0} ' })?.action).toEqual({ mutation: 'stash-apply', ref: 'stash@{0}' });
    expect(buildStashAction('pop', { ref: ' stash@{0} ' })?.action).toEqual({ mutation: 'stash-pop', ref: 'stash@{0}' });
    expect(buildStashAction('drop', { ref: ' stash@{0} ' })?.action).toEqual({ mutation: 'stash-drop', ref: 'stash@{0}' });
  });

  test('maps recovery attention without sending an invalid bisect operation', () => {
    expect(buildAttentionAction('merge', 'continue')?.action).toEqual({ mutation: 'merge-continue' });
    expect(buildAttentionAction('rebase', 'abort')?.action).toEqual({ mutation: 'rebase-abort' });
    expect(buildAttentionAction('cherry-pick', 'continue')?.action).toEqual({ mutation: 'cherry-pick-continue' });
    expect(buildAttentionAction('revert', 'abort')?.action).toEqual({ mutation: 'revert-abort' });
    expect(buildAttentionAction('bisect', 'continue')).toBeNull();
  });

  test('marks destructive mutations for parent confirmation', () => {
    expect(buildBranchAction('delete', { branch: 'topic' })?.destructive).toBe(true);
    expect(buildCommitAction('reset-hard', commit)?.destructive).toBe(true);
    expect(buildStashAction('drop', { ref: 'stash@{0}' })?.destructive).toBe(true);
    expect(buildStashAction('apply', { ref: 'stash@{0}' })?.destructive).toBe(false);
  });

  test('includes the actual branch, stash, and commit target in confirmations', () => {
    expect(buildBranchAction('delete', { branch: 'topic' })?.message).toContain('topic');
    expect(buildStashAction('drop', { ref: 'stash@{0}' })?.message).toContain('stash@{0}');
    expect(buildCommitAction('revert', commit)?.message).toContain(commit);
  });
});
