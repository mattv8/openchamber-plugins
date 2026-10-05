import { spawn, type ChildProcess } from 'node:child_process';
import { z } from 'zod';
import { CommitAuthorSchema, type CommitAuthor } from '../shared/protocol.js';
import type { Repository } from './contracts.js';

const GH_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 256_000;
const MAX_CACHE_ENTRIES = 256;
const MAX_IN_FLIGHT = 32;
const POSITIVE_TTL_MS = 10 * 60_000;
const NEGATIVE_TTL_MS = 60_000;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const GITHUB_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9])?$/;

type Remote = { name: string; fetchUrl: string | null; pushUrl: string | null };
type GhResult = { exitCode: number; stdout: Buffer; stderr: Buffer; unavailable?: boolean };
export type GhExecutor = (args: readonly string[], signal: AbortSignal) => Promise<GhResult>;
export type GitHubFetch = (input: string, init: RequestInit) => Promise<Response>;
export type CommitAuthorLookupOptions = {
  readRemotes: (repository: Repository) => Promise<Remote[]>;
  execGh?: GhExecutor;
  fetch?: GitHubFetch;
  now?: () => number;
  timeoutMs?: number;
};

function noninteractiveEnvironment(): NodeJS.ProcessEnv {
  const env = process.env;
  return { PATH: env.PATH, HOME: env.HOME, USERPROFILE: env.USERPROFILE, SYSTEMROOT: env.SYSTEMROOT, TEMP: env.TEMP, TMP: env.TMP, LANG: env.LANG, LC_ALL: env.LC_ALL, XDG_CONFIG_HOME: env.XDG_CONFIG_HOME, GH_CONFIG_DIR: env.GH_CONFIG_DIR, DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' };
}

/** Runs gh without inheriting credentials into argv or stdout logging. */
export function createGhExecutor(timeoutMs = GH_TIMEOUT_MS, spawnChild: typeof spawn = spawn): GhExecutor & { close: () => void } {
  const children = new Map<ChildProcess, () => void>();
  let closed = false;
  const execute = (args: readonly string[], signal: AbortSignal) => new Promise<GhResult>((resolve) => {
    if (closed || signal.aborted) { resolve({ exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), unavailable: closed }); return; }
    let child: ChildProcess;
    try { child = spawnChild('gh', [...args], { shell: false, windowsHide: true, detached: process.platform !== 'win32', env: noninteractiveEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { const code = (error as NodeJS.ErrnoException).code; resolve({ exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), unavailable: code === 'ENOENT' || code === 'EACCES' }); return; }
    const stdout: Buffer[] = []; const stderr: Buffer[] = []; let bytes = 0; let settled = false; let termination: GhResult | undefined; let killTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: GhResult) => { if (settled) return; settled = true; children.delete(child); clearTimeout(timer); if (killTimer) clearTimeout(killTimer); signal.removeEventListener('abort', terminate); resolve(result); };
    const terminate = () => {
      if (termination || settled) return;
      termination = { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      if (process.platform !== 'win32' && child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); } } else child.kill('SIGTERM');
      killTimer = setTimeout(() => { if (settled) return; if (process.platform !== 'win32' && child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } } else child.kill('SIGKILL'); }, 1_000);
    };
    const timer = setTimeout(terminate, timeoutMs);
    const receive = (into: Buffer[]) => (chunk: Buffer) => { if (settled || termination) return; bytes += chunk.byteLength; if (bytes > MAX_OUTPUT_BYTES) terminate(); else into.push(chunk); };
    child.stdout!.on('data', receive(stdout)); child.stderr!.on('data', receive(stderr));
    child.once('error', (error: NodeJS.ErrnoException) => { if (!termination) finish({ exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), unavailable: error.code === 'ENOENT' || error.code === 'EACCES' }); });
    child.once('close', (code) => finish(termination ?? { exitCode: code ?? 1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
    children.set(child, terminate);
    signal.addEventListener('abort', terminate, { once: true });
  });
  execute.close = () => { closed = true; for (const terminate of children.values()) terminate(); };
  return execute;
}

function githubRepository(value: string): { owner: string; repo: string } | null {
  let path: string | null = null;
  const scp = /^git@github\.com:([^\s?#]+)$/i.exec(value);
  if (scp) path = scp[1] ?? null;
  else {
    try { const url = new URL(value); if (url.hostname.toLowerCase() === 'github.com' && ['https:', 'http:', 'ssh:'].includes(url.protocol) && !url.search && !url.hash) path = url.pathname; } catch { return null; }
  }
  if (!path || path.includes('%')) return null;
  const parts = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/');
  if (parts.length !== 2 || !GITHUB_NAME.test(parts[0] ?? '') || !GITHUB_NAME.test(parts[1] ?? '')) return null;
  return { owner: parts[0]!, repo: parts[1]! };
}

const GitHubAuthorSchema = z.object({ login: z.string(), avatar_url: z.string() }).passthrough().nullable();

function authorFrom(value: unknown): CommitAuthor | null {
  if (!value || typeof value !== 'object') return null;
  const raw = GitHubAuthorSchema.safeParse((value as { author?: unknown }).author);
  if (!raw.success || raw.data === null) return null;
  return CommitAuthorSchema.safeParse({ login: raw.data.login, avatarUrl: raw.data.avatar_url }).data ?? null;
}

function ghUnavailable(result: GhResult): boolean {
  return result.unavailable === true || (result.exitCode === 4 && /auth|login/i.test(result.stderr.toString('utf8'))) || /not logged into|authentication required|please run: gh auth login/i.test(result.stderr.toString('utf8'));
}

async function boundedResponseText(response: Response, signal: AbortSignal): Promise<string | null> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_OUTPUT_BYTES || signal.aborted) { await reader.cancel(); return null; }
      chunks.push(part.value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { reader.releaseLock(); }
}

export function createCommitAuthorLookup(options: CommitAuthorLookupOptions) {
  const execute = options.execGh ?? createGhExecutor();
  const fetcher: GitHubFetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? GH_TIMEOUT_MS;
  const cache = new Map<string, { author: CommitAuthor | null; expiresAt: number }>();
  const inFlight = new Map<string, Promise<CommitAuthor | null>>();
  const controllers = new Set<AbortController>();
  let closed = false;
  const retain = (key: string, author: CommitAuthor | null) => { if (closed) return author; cache.set(key, { author, expiresAt: now() + (author ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS) }); while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value as string); return author; };
  const read = async (repository: Repository, commit: string): Promise<CommitAuthor | null> => {
    if (closed || !SHA.test(commit)) return null;
    let remotes: Remote[];
    try { remotes = await options.readRemotes(repository); } catch { return null; }
    if (closed) return null;
    const selected = [...remotes.filter((remote) => remote.name === 'origin'), ...remotes.filter((remote) => remote.name !== 'origin')]
      .flatMap((remote) => [remote.fetchUrl, remote.pushUrl].map((url) => ({ remote, github: url ? githubRepository(url) : null }))).find((value) => value.github);
    if (!selected?.github) return null;
    const github = selected.github;
    const key = `${repository.root}\0${selected.remote.name}\0${github.owner}/${github.repo}\0${commit.toLowerCase()}`;
    const cached = cache.get(key); if (cached && cached.expiresAt > now()) return cached.author; if (cached) cache.delete(key);
    const pending = inFlight.get(key); if (pending) return pending;
    if (inFlight.size >= MAX_IN_FLIGHT) return null;
    const operation = (async () => {
      const controller = new AbortController(); controllers.add(controller);
      try {
        const resource = `repos/${github.owner}/${github.repo}/commits/${commit}`;
        let gh: GhResult;
        try { gh = await execute(['api', '--hostname', 'github.com', resource], controller.signal); } catch { return retain(key, null); }
        if (closed || controller.signal.aborted) return null;
        if (gh.exitCode === 0) { try { return retain(key, authorFrom(JSON.parse(gh.stdout.toString('utf8')))); } catch { return retain(key, null); } }
        if (!ghUnavailable(gh)) return retain(key, null);
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetcher(`https://api.github.com/${resource}`, { headers: { accept: 'application/vnd.github+json' }, redirect: 'error', signal: controller.signal });
          if (!response.ok) return retain(key, null);
          const body = await boundedResponseText(response, controller.signal);
          if (body === null) return retain(key, null);
          try { return retain(key, authorFrom(JSON.parse(body))); } catch { return retain(key, null); }
        } catch { return closed || controller.signal.aborted ? null : retain(key, null); } finally { clearTimeout(timeout); }
      } finally { controllers.delete(controller); }
    })();
    inFlight.set(key, operation);
    try { return await operation; } finally { inFlight.delete(key); }
  };
  return { read, close: () => { closed = true; for (const controller of controllers) controller.abort(); (execute as GhExecutor & { close?: () => void }).close?.(); cache.clear(); } };
}
