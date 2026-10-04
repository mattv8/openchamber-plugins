import type { Repository, ServiceContext } from './contracts.js';
import { ServiceError } from './contracts.js';

const MAX_REMOTES = 128;
const MAX_REMOTE_NAME = 512;
const MAX_URL_LENGTH = 2048;
const MAX_SERIALIZED_BYTES = 200_000;

type RemoteMetadata = { name: string; fetchUrl: string | null; pushUrl: string | null };

function fail(message: string): never {
  throw new ServiceError('internal', message);
}

function bounded(value: string): void {
  if (value.length > MAX_URL_LENGTH) throw new ServiceError('unsupported', 'Remote URL exceeds the maximum length');
}

function hasControl(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127);
}

function commandValue(output: Buffer): string | null {
  const decoded = output.toString('utf8');
  const value = decoded.endsWith('\n') ? decoded.slice(0, -1) : decoded;
  return hasControl(value) ? null : value;
}

function sanitizeScpUrl(value: string): string | null {
  const match = /^git@([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?):([^\s?#]+)$/.exec(value);
  return match ? value : null;
}

function sanitizeUrl(value: string): string | null {
  if (!value || hasControl(value)) return null;
  bounded(value);
  if (value.startsWith('git@')) return sanitizeScpUrl(value);

  let normalized: string;
  try {
    const parsed = new URL(value);
    if (!parsed.hostname || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'ssh:')) return null;
    if (parsed.protocol === 'ssh:' && parsed.username && parsed.username !== 'git') parsed.username = '';
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    normalized = parsed.href;
  } catch {
    return null;
  }
  bounded(normalized);
  return normalized;
}

async function hasConfig(context: ServiceContext, repository: Repository, key: string): Promise<boolean> {
  const result = await context.runGit(repository.root, ['config', '--get', key]);
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  return fail('Failed to read remote configuration');
}

async function effectiveUrl(context: ServiceContext, repository: Repository, args: string[]): Promise<string | null> {
  const result = await context.runGit(repository.root, args);
  if (result.exitCode !== 0) return fail('Failed to resolve remote URL');
  const value = commandValue(result.stdout);
  return value === null ? null : sanitizeUrl(value);
}

export async function readRemoteMetadata(context: ServiceContext, repository: Repository): Promise<RemoteMetadata[]> {
  const listed = await context.runGit(repository.root, ['remote']);
  if (listed.exitCode !== 0) fail('Failed to list remotes');
  const names = listed.stdout.toString('utf8');
  if (hasControl(names.replaceAll('\n', ''))) fail('Failed to list remotes');
  const remoteNames = names ? names.replace(/\n$/, '').split('\n') : [];
  if (remoteNames.length > MAX_REMOTES) throw new ServiceError('unsupported', 'Repository has too many remotes');

  const remotes: RemoteMetadata[] = [];
  for (const name of remoteNames) {
    if (!name || hasControl(name)) fail('Git returned an invalid remote name');
    if (name.length > MAX_REMOTE_NAME) throw new ServiceError('unsupported', 'Remote name exceeds the maximum length');
    const fetchConfigured = await hasConfig(context, repository, `remote.${name}.url`);
    const pushConfigured = await hasConfig(context, repository, `remote.${name}.pushurl`);
    const fetchUrl = fetchConfigured
      ? await effectiveUrl(context, repository, ['remote', 'get-url', '--', name])
      : null;
    const pushUrl = fetchConfigured || pushConfigured
      ? await effectiveUrl(context, repository, ['remote', 'get-url', '--push', '--', name])
      : null;
    remotes.push({ name, fetchUrl, pushUrl });
  }

  if (Buffer.byteLength(JSON.stringify(remotes), 'utf8') > MAX_SERIALIZED_BYTES) {
    throw new ServiceError('unsupported', 'Remote metadata exceeds the maximum serialized size');
  }
  return remotes;
}
