import { z } from 'zod';

/** Wire contract for the plugin-owned loopback Git service. */
export const PROTOCOL_VERSION = 1 as const;
const Id = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const Snapshot = z.string().min(1).max(256);
const Path = z.string().min(1).max(4096).refine((value) => !value.includes('\0') && !value.startsWith('-'), 'invalid path');
const Ref = z.string().min(1).max(512).refine((value) => !value.includes('\0') && !value.startsWith('-'), 'invalid ref');
const FullCommit = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i);
const OperationId = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const RequestBase = z.object({ version: z.literal(PROTOCOL_VERSION), requestId: Id, repositoryId: Id });
const SnapshotRequest = RequestBase.extend({ snapshot: Snapshot });
const FileChange = z.object({ path: Path, previousPath: Path.nullable(), status: z.enum(['A', 'M', 'D', 'R', 'C', 'T']), insertions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative(), isBinary: z.boolean() });
const RefInfo = z.object({ id: Ref, name: z.string().min(1).max(512), revision: FullCommit.nullable(), kind: z.enum(['head', 'local', 'remote', 'tag']), category: z.enum(['branches', 'remote-branches', 'tags']) });
export const JobReferenceSchema = z.object({ jobId: Id, state: z.enum(['queued', 'running']), acceptedAt: z.number().int().nonnegative() });

export const RepositorySchema = z.object({
  id: Id,
  root: z.string().min(1).max(4096),
  commonGitDir: z.string().min(1).max(4096),
  head: FullCommit.nullable(),
  snapshot: Snapshot,
});

const StatusSchema = z.object({
  current: z.string().max(512), tracking: z.string().max(512).nullable(), ahead: z.number().int().nonnegative(), behind: z.number().int().nonnegative(), isClean: z.boolean(),
  files: z.array(z.object({ path: Path, index: z.string().max(2), workingDirectory: z.string().max(2), staged: z.boolean(), unstaged: z.boolean() })).max(5000),
  attention: z.enum(['merge', 'rebase', 'cherry-pick', 'revert', 'bisect']).nullable(),
});
const HistoryItem = z.object({ id: FullCommit, parentIds: z.array(FullCommit).max(32), subject: z.string().max(8192), message: z.string().max(65536), author: z.string().max(512), authorEmail: z.string().max(512), timestamp: z.string().datetime({ offset: true }), statistics: z.object({ files: z.number().int().nonnegative(), insertions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative() }), references: z.array(RefInfo).max(128) });
const DiffChunk = z.object({ snapshot: Snapshot, chunkId: Id, offset: z.number().int().nonnegative(), totalBytes: z.number().int().nonnegative(), complete: z.boolean(), text: z.string().max(240000), isBinary: z.boolean(), truncated: z.boolean() });
const Hunk = z.object({ id: Id, oldStart: z.number().int().nonnegative(), oldLines: z.number().int().nonnegative(), newStart: z.number().int().nonnegative(), newLines: z.number().int().nonnegative() });

export const ReadOperationSchema = z.enum(['status', 'history', 'refs', 'merge-base', 'resolve-commit', 'commit-files', 'commit-file-preview', 'working-tree', 'working-tree-diff', 'hunks', 'range-diff', 'range-files']);
const ReadRequestSchema = z.discriminatedUnion('read', [
  SnapshotRequest.extend({ operation: z.literal('read'), read: z.literal('status') }),
  SnapshotRequest.extend({ operation: z.literal('read'), read: z.literal('history'), refs: z.array(Ref).min(1).max(32), cursor: z.string().min(1).max(1024).nullable(), limit: z.number().int().min(1).max(100) }),
  SnapshotRequest.extend({ operation: z.literal('read'), read: z.literal('refs'), cursor: z.string().min(1).max(1024).nullable().optional(), limit: z.number().int().min(1).max(200).optional() }),
  SnapshotRequest.extend({ operation: z.literal('read'), read: z.literal('merge-base'), refs: z.array(Ref).length(2) }),
  SnapshotRequest.extend({ operation: z.literal('read'), read: z.literal('resolve-commit'), candidate: z.string().regex(/^(?:[0-9a-f]{7,40}|[0-9a-f]{64})$/i) }),
  SnapshotRequest.extend({ operation: z.literal('read'), read: z.literal('commit-files'), commit: FullCommit, parent: FullCommit.nullable() }),
  SnapshotRequest.extend({ operation: z.literal('read'), read: z.literal('commit-file-preview'), commit: FullCommit, parent: FullCommit.nullable(), originalPath: Path.nullable(), modifiedPath: Path.nullable(), offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(240000) }),
  SnapshotRequest.extend({ operation: z.literal('read'), read: z.literal('working-tree') }),
  SnapshotRequest.extend({ operation: z.literal('read'), read: z.literal('working-tree-diff'), path: Path, scope: z.enum(['staged', 'unstaged']), offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(240000) }),
  SnapshotRequest.extend({ operation: z.literal('read'), read: z.literal('hunks'), path: Path, scope: z.enum(['staged', 'unstaged']) }),
  SnapshotRequest.extend({ operation: z.literal('read'), read: z.literal('range-diff'), base: Ref, head: Ref, path: Path.nullable(), includeWorkingTree: z.boolean(), offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(240000) }),
  SnapshotRequest.extend({ operation: z.literal('read'), read: z.literal('range-files'), base: Ref, head: Ref, includeWorkingTree: z.boolean() }),
]);

export const MutationSchema = z.discriminatedUnion('mutation', [
  z.object({ mutation: z.literal('stage-path'), path: Path }), z.object({ mutation: z.literal('unstage-path'), path: Path }), z.object({ mutation: z.literal('discard-path'), path: Path, scope: z.enum(['working', 'all']) }),
  z.object({ mutation: z.literal('stage-hunk'), path: Path, hunkId: Id }), z.object({ mutation: z.literal('unstage-hunk'), path: Path, hunkId: Id }), z.object({ mutation: z.literal('discard-hunk'), path: Path, hunkId: Id }),
  z.object({ mutation: z.literal('commit'), message: z.string().min(1).max(65536) }), z.object({ mutation: z.literal('checkout'), branch: Ref }), z.object({ mutation: z.literal('create-branch'), name: Ref, startPoint: Ref.nullable() }), z.object({ mutation: z.literal('rename-branch'), oldName: Ref, newName: Ref }), z.object({ mutation: z.literal('delete-branch'), branch: Ref, force: z.boolean() }),
  z.object({ mutation: z.literal('create-tag'), name: Ref, commit: FullCommit }), z.object({ mutation: z.literal('delete-tag'), name: Ref }),
  z.object({ mutation: z.literal('fetch'), remote: z.string().min(1).max(512).nullable() }), z.object({ mutation: z.literal('pull'), remote: z.string().min(1).max(512).nullable(), branch: Ref.nullable(), rebase: z.boolean() }), z.object({ mutation: z.literal('push'), remote: z.string().min(1).max(512).nullable(), branch: Ref.nullable(), forceWithLease: z.boolean() }),
  z.object({ mutation: z.literal('stash-create'), message: z.string().max(65536).nullable(), includeUntracked: z.boolean() }), z.object({ mutation: z.literal('stash-apply'), ref: Ref }), z.object({ mutation: z.literal('stash-pop'), ref: Ref }), z.object({ mutation: z.literal('stash-drop'), ref: Ref }),
  z.object({ mutation: z.literal('merge'), branch: Ref }), z.object({ mutation: z.literal('merge-continue') }), z.object({ mutation: z.literal('merge-abort') }), z.object({ mutation: z.literal('rebase'), onto: Ref }), z.object({ mutation: z.literal('rebase-continue') }), z.object({ mutation: z.literal('rebase-abort') }),
  z.object({ mutation: z.literal('cherry-pick'), commit: FullCommit }), z.object({ mutation: z.literal('cherry-pick-continue') }), z.object({ mutation: z.literal('cherry-pick-abort') }), z.object({ mutation: z.literal('revert'), commit: FullCommit }), z.object({ mutation: z.literal('revert-continue') }), z.object({ mutation: z.literal('revert-abort') }), z.object({ mutation: z.literal('reset'), commit: FullCommit, mode: z.enum(['soft', 'mixed', 'hard']), force: z.boolean() }),
]);

const MutationRequestSchema = SnapshotRequest.extend({ operation: z.literal('mutate'), operationId: OperationId, expectedSnapshot: Snapshot, action: MutationSchema });
export const GitGraphRequestSchema = z.discriminatedUnion('operation', [
  RequestBase.extend({ operation: z.literal('repo/open'), directory: z.string().min(1).max(4096) }),
  ReadRequestSchema,
  MutationRequestSchema,
  RequestBase.extend({ operation: z.literal('jobs/get'), jobId: Id }),
  SnapshotRequest.extend({ operation: z.literal('refresh') }),
]);

export const ReadDataSchema = z.discriminatedUnion('read', [
  z.object({ read: z.literal('status'), status: StatusSchema }),
  z.object({ read: z.literal('history'), items: z.array(HistoryItem).max(100), nextCursor: z.string().max(1024).nullable(), hasMore: z.boolean(), refsSnapshot: Snapshot }),
  z.object({ read: z.literal('refs'), refs: z.array(RefInfo).max(1024), current: RefInfo.nullable(), upstream: RefInfo.nullable(), base: RefInfo.nullable(), nextCursor: z.string().max(1024).nullable().optional() }),
  z.object({ read: z.literal('merge-base'), mergeBase: FullCommit.nullable() }),
  z.object({ read: z.literal('resolve-commit'), commit: FullCommit.nullable(), ambiguous: z.boolean() }),
  z.object({ read: z.literal('commit-files'), files: z.array(FileChange).max(5000) }),
  z.object({ read: z.literal('commit-file-preview'), chunk: DiffChunk, originalAvailable: z.boolean(), modifiedAvailable: z.boolean() }),
  z.object({ read: z.literal('working-tree'), status: StatusSchema, stashes: z.array(z.object({ ref: Ref, message: z.string().max(8192), hash: FullCommit })).max(1024) }),
  z.object({ read: z.literal('working-tree-diff'), chunk: DiffChunk }),
  z.object({ read: z.literal('hunks'), snapshot: Snapshot, hunks: z.array(Hunk).max(2000) }),
  z.object({ read: z.literal('range-diff'), chunk: DiffChunk, mergeBase: FullCommit.nullable() }),
  z.object({ read: z.literal('range-files'), files: z.array(FileChange).max(5000), mergeBase: FullCommit.nullable() }),
]);
const ErrorData = z.object({ code: z.enum(['invalid-request', 'not-a-repository', 'repository-busy', 'snapshot-conflict', 'stale-cursor', 'not-found', 'conflict', 'unsupported', 'timeout-unknown', 'job-lost', 'internal']), message: z.string().min(1).max(4096), retryable: z.boolean(), snapshot: Snapshot.nullable() });

export const GitGraphSuccessResponseSchema = z.discriminatedUnion('operation', [
  z.object({ version: z.literal(PROTOCOL_VERSION), requestId: Id, operation: z.literal('repo/open'), ok: z.literal(true), data: RepositorySchema }),
  z.object({ version: z.literal(PROTOCOL_VERSION), requestId: Id, operation: z.literal('read'), ok: z.literal(true), data: z.union([ReadDataSchema, JobReferenceSchema]) }),
  z.object({ version: z.literal(PROTOCOL_VERSION), requestId: Id, operation: z.literal('mutate'), ok: z.literal(true), data: z.union([z.object({ operationId: OperationId, snapshot: Snapshot, result: z.object({ state: z.enum(['completed', 'conflict']), message: z.string().max(8192).nullable() }) }), JobReferenceSchema]) }),
  z.object({ version: z.literal(PROTOCOL_VERSION), requestId: Id, operation: z.literal('jobs/get'), ok: z.literal(true), data: z.object({ jobId: Id, state: z.enum(['queued', 'running', 'completed', 'failed', 'unknown']), data: z.union([ReadDataSchema, z.object({ operationId: OperationId, snapshot: Snapshot, result: z.object({ state: z.enum(['completed', 'conflict']), message: z.string().max(8192).nullable() }) })]).nullable(), result: z.object({ operationId: OperationId, snapshot: Snapshot }).nullable().optional(), error: ErrorData.nullable() }) }),
  z.object({ version: z.literal(PROTOCOL_VERSION), requestId: Id, operation: z.literal('refresh'), ok: z.literal(true), data: z.object({ snapshot: Snapshot, changed: z.boolean() }) }),
]);
export const GitGraphErrorResponseSchema = z.object({ version: z.literal(PROTOCOL_VERSION), requestId: Id, operation: z.enum(['repo/open', 'read', 'mutate', 'jobs/get', 'refresh']), ok: z.literal(false), error: ErrorData });
export const GitGraphResponseSchema = z.union([GitGraphSuccessResponseSchema, GitGraphErrorResponseSchema]);

export type GitGraphRequest = z.infer<typeof GitGraphRequestSchema>;
export type GitGraphResponse = z.infer<typeof GitGraphResponseSchema>;
export type GitGraphMutation = z.infer<typeof MutationSchema>;
export type GitGraphReadOperation = z.infer<typeof ReadOperationSchema>;
