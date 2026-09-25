import type { GitGraphMutation, GitGraphRequest, GitGraphResponse } from '../../shared/protocol.js';
export * from './diff.js';
export * from './graph.js';
export * from './tabs.js';
export * from './controls.js';

type ReadResponse = Extract<GitGraphResponse, { ok: true; operation: 'read' }>;
type ReadData = Exclude<ReadResponse['data'], { jobId: string }>;
type MutationResponse = Extract<GitGraphResponse, { ok: true; operation: 'mutate' }>;
type MutationData = Exclude<MutationResponse['data'], { jobId: string }>;
/** The panel never receives an accepted job: the adapter resolves it or returns its terminal error. */
export type ResolvedGitGraphResponse = Exclude<GitGraphResponse, ReadResponse | MutationResponse>
  | { version: 1; requestId: string; operation: 'read'; ok: true; data: ReadData }
  | { version: 1; requestId: string; operation: 'mutate'; ok: true; data: MutationData };
export type GitGraphServiceClient = { request(request: GitGraphRequest): Promise<ResolvedGitGraphResponse> };
export type PanelHost = { toast?(message: string, kind?: 'error' | 'success' | 'info'): void; copy?(value: string): Promise<void> | void; openUrl?(url: string): Promise<void> | void; confirm?(request: { title: string; message: string; destructive: boolean }): Promise<boolean> };
export type Translate = (key: string, values?: Record<string, string | number>) => string;
export type WorkspaceProps = { directory: string; service: GitGraphServiceClient; host?: PanelHost; active?: boolean; pollIntervalMs?: number; initialCommit?: string | null; t?: Translate };
export type MutationIntent = { title: string; message: string; destructive: boolean; action: GitGraphMutation };
export function requestId(prefix: string): string { return `${prefix}:${crypto.randomUUID()}`; }
export async function confirmMutation(host: PanelHost | undefined, intent: MutationIntent, browserConfirm: (message: string) => boolean): Promise<boolean> {
  return host?.confirm ? host.confirm({ title: intent.title, message: intent.message, destructive: intent.destructive }) : !intent.destructive || browserConfirm(intent.message);
}
