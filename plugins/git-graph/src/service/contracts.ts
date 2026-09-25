import type { GitGraphMutation, GitGraphRequest, GitGraphResponse } from '../shared/protocol.js';

export type Repository = { id: string; root: string; commonGitDir: string; gitDir: string; snapshot: string };
export type GitResult = { stdout: Buffer; stderr: Buffer; exitCode: number };
export type GitRunOptions = { input?: string | Buffer; timeoutMs?: number; maxOutputBytes?: number };
export type GitRunner = (cwd: string, args: readonly string[], options?: GitRunOptions) => Promise<GitResult>;
export type ReadRequest = Extract<GitGraphRequest, { operation: 'read' }>;
export type ReadData = Exclude<Extract<GitGraphResponse, { ok: true; operation: 'read' }>['data'], { jobId: string }>;
export type HunkRecord = { repositoryId: string; snapshot: string; path: string; scope: 'staged' | 'unstaged'; patch: string };
export type ServiceContext = {
  runGit: GitRunner;
  refresh: (repository: Repository) => Promise<string>;
  rememberHunk: (key: string, hunk: HunkRecord) => void;
  getHunk: (key: string) => HunkRecord | undefined;
};

export class ServiceError extends Error {
  constructor(public code: 'invalid-request'|'not-a-repository'|'repository-busy'|'snapshot-conflict'|'stale-cursor'|'not-found'|'conflict'|'unsupported'|'timeout-unknown'|'job-lost'|'internal', message: string, public retryable = false) { super(message); }
}

export async function requireGit(runner: GitRunner, cwd: string, args: readonly string[], options?: GitRunOptions): Promise<Buffer> {
  const result = await runner(cwd, args, options);
  if (result.exitCode === 0) return result.stdout;
  const stderr = result.stderr.toString('utf8');
  if (/index\.lock|another git process/i.test(stderr)) throw new ServiceError('repository-busy', 'Repository is busy in another Git process', true);
  if (/not a git repository/i.test(stderr)) throw new ServiceError('not-a-repository', 'Directory is not a Git repository');
  if (/conflict|needs merge|could not apply|automatic merge failed/i.test(stderr)) throw new ServiceError('conflict', 'Git operation has conflicts');
  if (/unknown revision|bad revision|ambiguous argument|pathspec .* did not match|not a valid object name/i.test(stderr)) throw new ServiceError('not-found', 'Requested Git object was not found');
  throw new ServiceError('internal', 'Git command failed');
}

export function validatePath(value: string): string {
  if (!value || value.includes('\0') || /^[\\/]|^[A-Za-z]:[\\/]/.test(value) || value.split(/[\\/]/).includes('..')) throw new ServiceError('invalid-request', 'Invalid repository path');
  return value;
}

export function validateRef(value: string): string {
  if (!value || value.startsWith('-') || [...value].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)) throw new ServiceError('invalid-request', 'Invalid Git ref');
  return value;
}

export type { GitGraphMutation };
