import { useEffect, useRef, useState } from 'react';
import type { MutationIntent, Translate } from '../domain/index.js';
import {
  buildAttentionAction,
  buildBranchAction,
  buildCommitAction,
  buildRefAction,
  buildStashAction,
  buildTagAction,
  type GitAttention,
  type RefInfo,
  type StashInfo,
  withActionCopy,
} from '../domain/actions.js';

export type GitActionsProps = {
  refs: readonly RefInfo[];
  stashes: readonly StashInfo[];
  selectedCommit: string | null;
  attention: GitAttention;
  pending: boolean;
  onAction(intent: MutationIntent): void;
  t?: Translate;
};

type FormKind = 'create-branch' | 'rename-branch' | 'create-tag' | 'stash-save' | null;

const fallbackT: Translate = (key) => key;
const label = (t: Translate, key: string, fallback: string): string => {
  const value = t(key);
  return value === key ? fallback : value;
};

export function GitActions({ refs, stashes, selectedCommit, attention, pending, onAction, t = fallbackT }: GitActionsProps) {
  const [form, setForm] = useState<FormKind>(null);
  const [name, setName] = useState('');
  const [selectedBranch, setSelectedBranch] = useState('');
  const [selectedTag, setSelectedTag] = useState('');
  const [selectedStashHash, setSelectedStashHash] = useState('');
  const [stashMessage, setStashMessage] = useState('');
  const [includeUntracked, setIncludeUntracked] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const branches = refs.filter((item) => item.category === 'branches');
  const tags = refs.filter((item) => item.category === 'tags');
  const selectedStash = stashes.find((stash) => stash.hash === selectedStashHash) ?? null;
  const actionLabel = (key: string, fallback: string) => label(t, `gitActions.${key}`, fallback);
  const submit = (intent: MutationIntent | null, title: string) => {
    if (!intent || pending) return;
    onAction(withActionCopy(intent, title));
    setForm(null);
    setName('');
    setStashMessage('');
  };
  const openForm = (next: Exclude<FormKind, null>) => { if (!pending) setForm(next); };
  const cancelForm = () => { setForm(null); setName(''); setStashMessage(''); };

  useEffect(() => { input.current?.focus(); }, [form]);
  useEffect(() => { if (selectedStashHash && !selectedStash) setSelectedStashHash(''); }, [selectedStash, selectedStashHash]);
  useEffect(() => {
    if (!form) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') cancelForm(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [form]);

  const run = (intent: MutationIntent | null, key: string, fallback: string) => submit(intent, actionLabel(key, fallback));
  const modalTitle = form === 'create-branch' ? actionLabel('createBranch', 'Create branch') : form === 'rename-branch' ? actionLabel('renameBranch', 'Rename branch') : form === 'create-tag' ? actionLabel('createTag', 'Create tag') : actionLabel('stashSave', 'Save stash');

  return <section className="git-actions" data-git-graph-actions="true" aria-label={actionLabel('label', 'Git actions')}>
    <div data-git-graph-actions-branches="true">
      <h2>{actionLabel('branches', 'Branches')}</h2>
      <select value={selectedBranch} onChange={(event) => setSelectedBranch(event.target.value)} aria-label={actionLabel('branch', 'Branch')} disabled={pending}>
        <option value="">{actionLabel('selectBranch', 'Select a branch')}</option>
        {branches.map((branch) => <option key={branch.id} value={branch.name}>{branch.name}</option>)}
      </select>
      <button type="button" disabled={pending} onClick={() => openForm('create-branch')}>{actionLabel('createBranch', 'Create branch')}</button>
      <button type="button" disabled={pending || !selectedBranch} onClick={() => run(buildBranchAction('checkout', { branch: selectedBranch }), 'checkoutBranch', 'Checkout branch')}>{actionLabel('checkout', 'Checkout')}</button>
      <button type="button" disabled={pending || !selectedBranch} onClick={() => openForm('rename-branch')}>{actionLabel('rename', 'Rename')}</button>
      <button type="button" disabled={pending || !selectedBranch} onClick={() => run(buildBranchAction('delete', { branch: selectedBranch }), 'deleteBranch', 'Delete branch')}>{actionLabel('delete', 'Delete')}</button>
      <button type="button" disabled={pending || !selectedBranch} onClick={() => run(buildRefAction('merge', selectedBranch), 'merge', 'Merge branch')}>{actionLabel('merge', 'Merge')}</button>
      <button type="button" disabled={pending || !selectedBranch} onClick={() => run(buildRefAction('rebase', selectedBranch), 'rebase', 'Rebase onto branch')}>{actionLabel('rebase', 'Rebase')}</button>
    </div>
    <div data-git-graph-actions-tags="true">
      <h2>{actionLabel('tags', 'Tags')}</h2>
      <select value={selectedTag} onChange={(event) => setSelectedTag(event.target.value)} aria-label={actionLabel('tag', 'Tag')} disabled={pending}>
        <option value="">{actionLabel('selectTag', 'Select a tag')}</option>
        {tags.map((tag) => <option key={tag.id} value={tag.name}>{tag.name}</option>)}
      </select>
      <button type="button" disabled={pending || !selectedCommit} onClick={() => openForm('create-tag')}>{actionLabel('createTag', 'Create tag')}</button>
      <button type="button" disabled={pending || !selectedTag} onClick={() => run(buildTagAction('delete', { name: selectedTag }), 'deleteTag', 'Delete tag')}>{actionLabel('delete', 'Delete')}</button>
    </div>
    <div data-git-graph-actions-commit="true">
      <h2>{actionLabel('commit', 'Selected commit')}</h2>
      <button type="button" disabled={pending || !selectedCommit} onClick={() => run(buildCommitAction('checkout', selectedCommit), 'checkoutDetached', 'Checkout commit (detached)')}>{actionLabel('checkoutDetached', 'Checkout detached')}</button>
      <button type="button" disabled={pending || !selectedCommit} onClick={() => run(buildCommitAction('cherry-pick', selectedCommit), 'cherryPick', 'Cherry-pick commit')}>{actionLabel('cherryPick', 'Cherry-pick')}</button>
      <button type="button" disabled={pending || !selectedCommit} onClick={() => run(buildCommitAction('revert', selectedCommit), 'revert', 'Revert commit')}>{actionLabel('revert', 'Revert')}</button>
      {(['soft', 'mixed', 'hard'] as const).map((mode) => <button key={mode} type="button" disabled={pending || !selectedCommit} onClick={() => run(buildCommitAction(`reset-${mode}`, selectedCommit), `reset${mode[0]?.toUpperCase()}${mode.slice(1)}`, `Reset ${mode}`)}>{actionLabel(`reset${mode[0]?.toUpperCase()}${mode.slice(1)}`, `Reset ${mode}`)}</button>)}
    </div>
    <div data-git-graph-actions-stashes="true">
      <h2>{actionLabel('stashes', 'Stashes')}</h2>
      <select value={selectedStashHash} onChange={(event) => setSelectedStashHash(event.target.value)} aria-label={actionLabel('stash', 'Stash')} disabled={pending}>
        <option value="">{actionLabel('selectStash', 'Select a stash')}</option>
        {stashes.map((stash) => <option key={stash.hash} value={stash.hash}>{stash.message} ({stash.hash.slice(0, 8)})</option>)}
      </select>
      <button type="button" disabled={pending} onClick={() => openForm('stash-save')}>{actionLabel('stashSave', 'Save stash')}</button>
      <button type="button" disabled={pending || !selectedStash} onClick={() => run(buildStashAction('apply', selectedStash ? { ref: selectedStash.ref } : {}), 'stashApply', 'Apply stash')}>{actionLabel('stashApply', 'Apply')}</button>
      <button type="button" disabled={pending || !selectedStash} onClick={() => run(buildStashAction('pop', selectedStash ? { ref: selectedStash.ref } : {}), 'stashPop', 'Pop stash')}>{actionLabel('stashPop', 'Pop')}</button>
      <button type="button" disabled={pending || !selectedStash} onClick={() => run(buildStashAction('drop', selectedStash ? { ref: selectedStash.ref } : {}), 'stashDrop', 'Drop stash')}>{actionLabel('stashDrop', 'Drop')}</button>
    </div>
    {attention !== 'bisect' && attention && <div data-git-graph-actions-recovery="true"><h2>{actionLabel('recovery', 'Recovery')}</h2><button type="button" disabled={pending} onClick={() => run(buildAttentionAction(attention, 'continue'), 'continue', 'Continue')}>{actionLabel('continue', 'Continue')}</button><button type="button" disabled={pending} onClick={() => run(buildAttentionAction(attention, 'abort'), 'abort', 'Abort')}>{actionLabel('abort', 'Abort')}</button></div>}
    {form && <div className="git-confirm-backdrop git-actions-modal" data-git-graph-actions-modal="true"><form className="git-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="git-actions-modal-title" onSubmit={(event) => { event.preventDefault(); if (form === 'create-branch') run(buildBranchAction('create', { name, startPoint: selectedBranch }), 'createBranch', 'Create branch'); else if (form === 'rename-branch') run(buildBranchAction('rename', { oldName: selectedBranch, newName: name }), 'renameBranch', 'Rename branch'); else if (form === 'create-tag') run(buildTagAction('create', { name, commit: selectedCommit }), 'createTag', 'Create tag'); else run(buildStashAction('save', { message: stashMessage, includeUntracked }), 'stashSave', 'Save stash'); }}><h2 id="git-actions-modal-title">{modalTitle}</h2>{form === 'stash-save' ? <><input ref={input} value={stashMessage} onChange={(event) => setStashMessage(event.target.value)} aria-label={actionLabel('stashMessage', 'Stash message')} /><label><input type="checkbox" checked={includeUntracked} onChange={(event) => setIncludeUntracked(event.target.checked)} />{actionLabel('includeUntracked', 'Include untracked files')}</label></> : <input ref={input} value={name} onChange={(event) => setName(event.target.value)} aria-label={form === 'create-tag' ? actionLabel('tagName', 'Tag name') : actionLabel('branchName', 'Branch name')} required />}<button type="button" onClick={cancelForm}>{actionLabel('cancel', 'Cancel')}</button><button type="submit" disabled={pending || (form !== 'stash-save' && !name.trim())}>{actionLabel('submit', 'Continue')}</button></form></div>}
  </section>;
}
