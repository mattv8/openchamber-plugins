import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitGraphMutation } from '../shared/protocol.js';
import { ServiceError, requireGit, validatePath, validateRef, type Repository, type ServiceContext } from './contracts.js';

function output(value: Buffer) {
  return value.toString('utf8').trim();
}

async function succeeds(context: ServiceContext, repository: Repository, args: readonly string[]) {
  return (await context.runGit(repository.root, args)).exitCode === 0;
}

async function hasHead(context: ServiceContext, repository: Repository) {
  return succeeds(context, repository, ['rev-parse', '--verify', '--quiet', 'HEAD']);
}

async function requirePathInsideRepository(repository: Repository, value: string) {
  validatePath(value);
  let ancestor = repository.root;
  const parts = value.split(/[\\/]/);
  for (const part of parts.slice(0, -1)) {
    ancestor = join(ancestor, part);
    try {
      if ((await lstat(ancestor)).isSymbolicLink()) throw new ServiceError('invalid-request', 'Path crosses a symbolic link outside the repository');
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      return;
    }
  }
}

async function requireCommit(context: ServiceContext, repository: Repository, value: string) {
  validateRef(value);
  try {
    return output(await requireGit(context.runGit, repository.root, ['rev-parse', '--verify', '--end-of-options', `${value}^{commit}`]));
  } catch (error) {
    if (error instanceof ServiceError && error.code === 'internal') throw new ServiceError('not-found', `Commit target does not exist: ${value}`);
    throw error;
  }
}

async function requireBranchName(context: ServiceContext, repository: Repository, value: string) {
  validateRef(value);
  await requireGit(context.runGit, repository.root, ['check-ref-format', '--branch', value]);
  return value;
}

async function requireTagName(context: ServiceContext, repository: Repository, value: string) {
  validateRef(value);
  await requireGit(context.runGit, repository.root, ['check-ref-format', `refs/tags/${value}`]);
  return value;
}

async function requireRemote(context: ServiceContext, repository: Repository, value: string) {
  validateRef(value);
  try {
    await requireGit(context.runGit, repository.root, ['remote', 'get-url', '--', value]);
  } catch (error) {
    if (error instanceof ServiceError && error.code === 'internal') throw new ServiceError('not-found', `Remote does not exist: ${value}`);
    throw error;
  }
  return value;
}

async function requireOperationMarker(context: ServiceContext, repository: Repository, marker: 'MERGE_HEAD' | 'CHERRY_PICK_HEAD' | 'REVERT_HEAD' | 'rebase-merge' | 'rebase-apply') {
  if (marker === 'rebase-merge' || marker === 'rebase-apply') {
    try {
      await lstat(join(repository.gitDir, marker));
      return;
    } catch {
      throw new ServiceError('not-found', 'No rebase is in progress');
    }
  }
  if (!await succeeds(context, repository, ['rev-parse', '--verify', '--quiet', marker])) {
    throw new ServiceError('not-found', `No ${marker.toLowerCase().replace('_head', '')} is in progress`);
  }
}

async function requireMutationGit(context: ServiceContext, repository: Repository, args: readonly string[], marker?: 'MERGE_HEAD' | 'CHERRY_PICK_HEAD' | 'REVERT_HEAD' | 'rebase-merge') {
  try {
    await requireGit(context.runGit, repository.root, args);
  } catch (error) {
    if (marker && error instanceof ServiceError && error.code === 'internal') {
      try {
        await requireOperationMarker(context, repository, marker);
        throw new ServiceError('conflict', 'Git operation has conflicts');
      } catch (markerError) {
        if (markerError instanceof ServiceError && markerError.code === 'conflict') throw markerError;
      }
    }
    throw error;
  }
}

async function requireRebaseMarker(context: ServiceContext, repository: Repository) {
  try {
    await requireOperationMarker(context, repository, 'rebase-merge');
  } catch {
    await requireOperationMarker(context, repository, 'rebase-apply');
  }
}

async function verifyHunk(context: ServiceContext, repository: Repository, action: Extract<GitGraphMutation, { mutation: 'stage-hunk' | 'unstage-hunk' | 'discard-hunk' }>) {
  validatePath(action.path);
  const hunk = context.getHunk(action.hunkId);
  const scope = action.mutation === 'unstage-hunk' ? 'staged' : 'unstaged';
  if (!hunk || hunk.repositoryId !== repository.id || hunk.path !== action.path || hunk.scope !== scope) {
    throw new ServiceError('not-found', 'Selected hunk does not exist');
  }
  const snapshot = await context.refresh(repository);
  if (hunk.snapshot !== snapshot) throw new ServiceError('snapshot-conflict', 'Hunk is stale; reload the diff', true);
  const diffArgs = scope === 'staged'
    ? ['diff', '--cached', '--no-ext-diff', '--unified=0', '--', action.path]
    : ['diff', '--no-ext-diff', '--unified=0', '--', action.path];
  const patch = output(await requireGit(context.runGit, repository.root, diffArgs));
  const hunkStart = hunk.patch.indexOf('@@');
  const selectedHunk = hunkStart === -1 ? '' : hunk.patch.slice(hunkStart).trim();
  if (!selectedHunk || !patch.includes(selectedHunk)) throw new ServiceError('snapshot-conflict', 'Hunk no longer matches the current file', true);
  return hunk;
}

async function applyHunk(context: ServiceContext, repository: Repository, action: Extract<GitGraphMutation, { mutation: 'stage-hunk' | 'unstage-hunk' | 'discard-hunk' }>) {
  const hunk = await verifyHunk(context, repository, action);
  const args = action.mutation === 'stage-hunk'
    ? ['apply', '--check', '--cached', '--unidiff-zero']
    : action.mutation === 'unstage-hunk'
      ? ['apply', '--check', '--cached', '--reverse', '--unidiff-zero']
      : ['apply', '--check', '--reverse', '--unidiff-zero'];
  await requireGit(context.runGit, repository.root, args, { input: hunk.patch });
  await requireGit(context.runGit, repository.root, args.filter((argument) => argument !== '--check'), { input: hunk.patch });
}

async function restorePath(context: ServiceContext, repository: Repository, path: string, scope: 'working' | 'all') {
  validatePath(path);
  if (scope === 'all') {
    if (await hasHead(context, repository)) {
      if (await succeeds(context, repository, ['ls-files', '--error-unmatch', '--', path])) {
        const inHead = await context.runGit(repository.root, ['ls-tree', '-z', 'HEAD', '--', path]);
        if (inHead.exitCode === 0 && inHead.stdout.byteLength > 0) {
          await requireGit(context.runGit, repository.root, ['restore', '--source=HEAD', '--staged', '--worktree', '--', path]);
        } else {
          await requireGit(context.runGit, repository.root, ['rm', '--cached', '--ignore-unmatch', '--', path]);
        }
      }
    } else {
      await requireGit(context.runGit, repository.root, ['rm', '--cached', '--ignore-unmatch', '--', path]);
    }
  } else if (await succeeds(context, repository, ['ls-files', '--error-unmatch', '--', path])) {
    await requireGit(context.runGit, repository.root, ['restore', '--worktree', '--', path]);
  }
  // Git clean removes only untracked files under this literal path. It never
  // follows symlinked directories, so a discard cannot reach outside root.
  await requireGit(context.runGit, repository.root, ['clean', '-fd', '--', path]);
}

async function checkout(context: ServiceContext, repository: Repository, value: string) {
  validateRef(value);
  if (await succeeds(context, repository, ['show-ref', '--verify', '--quiet', `refs/heads/${value}`])) {
    await requireGit(context.runGit, repository.root, ['checkout', '--no-guess', value]);
    return;
  }
  await requireGit(context.runGit, repository.root, ['checkout', '--detach', await requireCommit(context, repository, value)]);
}

export async function mutateRepository(context: ServiceContext, repository: Repository, action: GitGraphMutation): Promise<void> {
  if ('path' in action) await requirePathInsideRepository(repository, action.path);
  switch (action.mutation) {
    case 'stage-path':
      await requireGit(context.runGit, repository.root, ['add', '--', action.path]); return;
    case 'unstage-path':
      if (await hasHead(context, repository)) await requireGit(context.runGit, repository.root, ['restore', '--staged', '--', action.path]);
      else await requireGit(context.runGit, repository.root, ['rm', '--cached', '--ignore-unmatch', '--', action.path]);
      return;
    case 'discard-path':
      await restorePath(context, repository, action.path, action.scope); return;
    case 'stage-hunk': case 'unstage-hunk': case 'discard-hunk':
      await applyHunk(context, repository, action); return;
    case 'commit':
      await requireGit(context.runGit, repository.root, ['commit', '-F', '-'], { input: action.message }); return;
    case 'checkout':
      await checkout(context, repository, action.branch); return;
    case 'create-branch':
      await requireBranchName(context, repository, action.name);
      await requireGit(context.runGit, repository.root, action.startPoint ? ['branch', action.name, await requireCommit(context, repository, action.startPoint)] : ['branch', action.name]); return;
    case 'rename-branch':
      await requireBranchName(context, repository, action.oldName); await requireBranchName(context, repository, action.newName);
      await requireGit(context.runGit, repository.root, ['branch', '-m', action.oldName, action.newName]); return;
    case 'delete-branch':
      await requireBranchName(context, repository, action.branch);
      await requireGit(context.runGit, repository.root, ['branch', action.force ? '-D' : '-d', action.branch]); return;
    case 'create-tag':
      await requireTagName(context, repository, action.name);
      await requireGit(context.runGit, repository.root, ['tag', action.name, await requireCommit(context, repository, action.commit)]); return;
    case 'delete-tag':
      validateRef(action.name);
      if (!await succeeds(context, repository, ['show-ref', '--verify', '--quiet', `refs/tags/${action.name}`])) throw new ServiceError('not-found', `Tag does not exist: ${action.name}`);
      await requireGit(context.runGit, repository.root, ['tag', '-d', action.name]); return;
    case 'fetch':
      await requireGit(context.runGit, repository.root, action.remote ? ['fetch', '--', await requireRemote(context, repository, action.remote)] : ['fetch']); return;
    case 'pull':
      if (action.branch) await requireCommit(context, repository, action.branch);
      await requireGit(context.runGit, repository.root, ['pull', ...(action.rebase ? ['--rebase'] : []), ...(action.remote ? ['--', await requireRemote(context, repository, action.remote)] : []), ...(action.branch ? [action.branch] : [])]); return;
    case 'push':
      if (action.branch) await requireCommit(context, repository, action.branch);
      await requireGit(context.runGit, repository.root, ['push', ...(action.forceWithLease ? ['--force-with-lease'] : []), ...(action.remote ? ['--', await requireRemote(context, repository, action.remote)] : []), ...(action.branch ? [action.branch] : [])]); return;
    case 'stash-create':
      await requireGit(context.runGit, repository.root, ['stash', 'push', ...(action.includeUntracked ? ['--include-untracked'] : []), ...(action.message ? ['-m', action.message] : [])]); return;
    case 'stash-apply': case 'stash-pop': case 'stash-drop':
      validateRef(action.ref); await requireCommit(context, repository, action.ref);
      await requireGit(context.runGit, repository.root, ['stash', action.mutation.slice('stash-'.length), '--', action.ref]); return;
    case 'merge':
      await requireMutationGit(context, repository, ['merge', '--no-edit', await requireCommit(context, repository, action.branch)], 'MERGE_HEAD'); return;
    case 'merge-continue':
      await requireOperationMarker(context, repository, 'MERGE_HEAD'); await requireGit(context.runGit, repository.root, ['-c', 'core.editor=true', 'merge', '--continue']); return;
    case 'merge-abort':
      await requireOperationMarker(context, repository, 'MERGE_HEAD'); await requireGit(context.runGit, repository.root, ['merge', '--abort']); return;
    case 'rebase':
      await requireMutationGit(context, repository, ['-c', 'core.editor=true', 'rebase', await requireCommit(context, repository, action.onto)], 'rebase-merge'); return;
    case 'rebase-continue':
      await requireRebaseMarker(context, repository); await requireGit(context.runGit, repository.root, ['-c', 'core.editor=true', 'rebase', '--continue']); return;
    case 'rebase-abort':
      await requireRebaseMarker(context, repository); await requireGit(context.runGit, repository.root, ['rebase', '--abort']); return;
    case 'cherry-pick':
      await requireMutationGit(context, repository, ['cherry-pick', await requireCommit(context, repository, action.commit)], 'CHERRY_PICK_HEAD'); return;
    case 'cherry-pick-continue':
      await requireOperationMarker(context, repository, 'CHERRY_PICK_HEAD'); await requireGit(context.runGit, repository.root, ['-c', 'core.editor=true', 'cherry-pick', '--continue']); return;
    case 'cherry-pick-abort':
      await requireOperationMarker(context, repository, 'CHERRY_PICK_HEAD'); await requireGit(context.runGit, repository.root, ['cherry-pick', '--abort']); return;
    case 'revert':
      await requireMutationGit(context, repository, ['revert', '--no-edit', await requireCommit(context, repository, action.commit)], 'REVERT_HEAD'); return;
    case 'revert-continue':
      await requireOperationMarker(context, repository, 'REVERT_HEAD'); await requireGit(context.runGit, repository.root, ['-c', 'core.editor=true', 'revert', '--continue']); return;
    case 'revert-abort':
      await requireOperationMarker(context, repository, 'REVERT_HEAD'); await requireGit(context.runGit, repository.root, ['revert', '--abort']); return;
    case 'reset':
      if (action.mode === 'hard' && !action.force) throw new ServiceError('invalid-request', 'Hard reset requires explicit confirmation');
      await requireGit(context.runGit, repository.root, ['reset', `--${action.mode}`, await requireCommit(context, repository, action.commit)]); return;
  }
}
