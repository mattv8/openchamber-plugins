import { join, resolve } from 'node:path';

const SHA = /^[0-9a-f]{40}$/;

export type HostTarget = 'stock' | 'electron';

export interface HostLock {
  stock: { repository: string; version: string; revision: string };
}

function isRepository(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseHostLock(value: unknown): HostLock {
  if (!isRecord(value) || !isRecord(value.stock)) throw new Error('hosts.lock.json must contain stock provenance.');
  const { stock } = value;
  if (!isRepository(stock.repository)) throw new Error('stock.repository must be an allowlisted owner/repository.');
  if (typeof stock.version !== 'string' || stock.version.length === 0) throw new Error('stock.version is required.');
  if (typeof stock.revision !== 'string' || !SHA.test(stock.revision)) throw new Error('stock.revision must be a lowercase 40-character SHA.');
  return { stock: { repository: stock.repository, version: stock.version, revision: stock.revision } };
}

function isRepositoryRemote(remote: string, repository: string): boolean {
  return new RegExp(`(?:github\\.com[:/]|^)${repository.replace('/', '[/]')}(?:\\.git)?$`).test(remote);
}

/** A fork is valid isolation evidence only when it declares the official upstream. */
export function hasTrustedHostRemote(remotes: { origin: string | null; upstream: string | null }, repository: string): boolean {
  return (remotes.origin !== null && isRepositoryRemote(remotes.origin, repository))
    || (remotes.upstream !== null && isRepositoryRemote(remotes.upstream, repository));
}

export function isCleanGitStatus(status: string): boolean {
  return status.trim().length === 0;
}

export function hostEnvironment(runRoot: string): NodeJS.ProcessEnv {
  const root = resolve(runRoot);
  return {
    HOME: resolve(root, 'home'),
    XDG_CONFIG_HOME: resolve(root, 'xdg-config'),
    OPENCHAMBER_DATA_DIR: resolve(root, 'openchamber-data'),
    OPENCODE_CONFIG_DIR: resolve(root, 'opencode-config'),
    OPENCODE_CONFIG: resolve(root, 'opencode-config/opencode.json'),
    OPENCHAMBER_DESKTOP_USER_DATA_DIR: resolve(root, 'electron-user-data'),
  };
}

export function isolatedEnvironment(runRoot: string, opencodeBinary: string, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment = hostEnvironment(runRoot);
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TERM', 'TZ']) {
    const value = inherited[key];
    if (value) environment[key] = value;
  }
  environment.OPENCODE_BINARY = opencodeBinary;
  environment.OPENCHAMBER_GUEST_UPLOAD_MAX_BYTES = '52428800';
  return environment;
}

export function electronExecutableCandidates(source: string, platform: NodeJS.Platform = process.platform): string[] {
  const dist = resolve(source, 'node_modules/electron/dist');
  if (platform === 'darwin') return [join(dist, 'Electron.app/Contents/MacOS/Electron')];
  if (platform === 'win32') return [join(dist, 'electron.exe')];
  return [join(dist, 'electron')];
}

export function uploadHeaders(bytes: number): Record<string, string> {
  return { 'content-type': 'application/octet-stream', 'content-length': String(bytes) };
}

export function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required; refusing to run an isolated-host test with an implicit input.`);
  return resolve(value);
}
