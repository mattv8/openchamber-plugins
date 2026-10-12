import { CommitAuthorSchema, type CommitAuthorLookup } from '../../shared/protocol.js';

const KEY_PREFIX = 'author-profile:v1:';
const ENTRY_VERSION = 1;
const PROFILE_TTL_MS = 24 * 60 * 60 * 1_000;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1_000;
const MAX_ENTRIES = 100;
const MAX_CACHE_BYTES = 1_024 * 1_024;
const MAX_IMAGE_BYTES = 9_216;
const MAX_DATA_URL_CHARS = 12_500;
const MAX_ENTRY_BYTES = 14 * 1_024;
const SAFE_UNKNOWN_ENTRY_COUNT = Math.floor((MAX_CACHE_BYTES - MAX_ENTRY_BYTES) / 65_536);
const AVATAR_TIMEOUT_MS = 5_000;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

type Storage = {
  get(key: string, options?: { scope?: 'instance' }): Promise<unknown>;
  set(key: string, value: AuthorProfileEntry, options?: { scope?: 'instance' }): Promise<void>;
  delete(key: string, options?: { scope?: 'instance' }): Promise<void>;
  keys(options?: { scope?: 'instance' }): Promise<string[]>;
};

type AvatarFetch = (input: string, init: RequestInit) => Promise<Response>;

export type AuthorProfileEntry = {
  v: 1;
  email: string;
  resolution: 'linked' | 'unlinked';
  login: string | null;
  avatarUrl: string | null;
  avatarData: string | null;
  fetchedAt: number;
};

type AuthorProfileCache = {
  read(email: string): Promise<AuthorProfileEntry | null>;
  write(email: string, lookup: CommitAuthorLookup, signal: AbortSignal): Promise<AuthorProfileEntry | null>;
  fillAvatar(entry: AuthorProfileEntry, signal: AbortSignal): Promise<AuthorProfileEntry>;
};

const storageOptions = { scope: 'instance' } as const;
const textEncoder = new TextEncoder();

function normalizeEmail(email: string): string { return email.trim().toLowerCase(); }

/** Uses 64-bit FNV-1a to keep raw author emails out of storage keys. */
export function authorProfileKey(email: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of textEncoder.encode(normalizeEmail(email))) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return `${KEY_PREFIX}${hash.toString(16).padStart(16, '0')}`;
}

function byteLength(value: unknown): number { return textEncoder.encode(JSON.stringify(value)).byteLength; }

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function isDataUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_DATA_URL_CHARS) return false;
  const match = /^data:image\/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/]*={0,2})$/.exec(value);
  const encoded = match?.[1];
  if (!encoded || encoded.length % 4 !== 0) return false;
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  return (encoded.length / 4) * 3 - padding <= MAX_IMAGE_BYTES;
}

function parseEntry(value: unknown): AuthorProfileEntry | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  const keys = Object.keys(entry).sort();
  if (keys.join(',') !== 'avatarData,avatarUrl,email,fetchedAt,login,resolution,v' || entry.v !== ENTRY_VERSION || typeof entry.email !== 'string' || !entry.email || entry.email.length > 512 || normalizeEmail(entry.email) !== entry.email || typeof entry.fetchedAt !== 'number' || !Number.isInteger(entry.fetchedAt) || entry.fetchedAt < 0) return null;
  if (entry.resolution === 'unlinked' && entry.login === null && entry.avatarUrl === null && entry.avatarData === null) {
    const parsed: AuthorProfileEntry = { v: 1, email: entry.email, resolution: 'unlinked', login: null, avatarUrl: null, avatarData: null, fetchedAt: entry.fetchedAt };
    return byteLength(parsed) <= MAX_ENTRY_BYTES ? parsed : null;
  }
  if (entry.resolution !== 'linked' || entry.avatarData !== null && !isDataUrl(entry.avatarData)) return null;
  const author = CommitAuthorSchema.safeParse({ login: entry.login, avatarUrl: entry.avatarUrl });
  if (!author.success) return null;
  const parsed: AuthorProfileEntry = { v: 1, email: entry.email, resolution: 'linked', login: author.data.login, avatarUrl: author.data.avatarUrl, avatarData: entry.avatarData, fetchedAt: entry.fetchedAt };
  return byteLength(parsed) <= MAX_ENTRY_BYTES ? parsed : null;
}

function isFresh(entry: AuthorProfileEntry, now: number): boolean {
  return entry.fetchedAt <= now + FUTURE_TOLERANCE_MS && now - entry.fetchedAt < PROFILE_TTL_MS;
}

function canonicalAvatarUrl(value: string): string | null {
  try {
    const source = new URL(value);
    if (source.protocol !== 'https:' || source.hostname !== 'avatars.githubusercontent.com' || source.port || source.username || source.password || source.hash || !/^\/u\/\d+$/.test(source.pathname)) return null;
    const target = new URL(`https://avatars.githubusercontent.com${source.pathname}`);
    const version = source.searchParams.get('v');
    if (version) target.searchParams.set('v', version);
    target.searchParams.set('s', '40');
    return target.toString();
  } catch { return null; }
}

async function readBoundedBody(response: Response, signal: AbortSignal): Promise<Uint8Array | null> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_IMAGE_BYTES) return null;
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (!signal.aborted) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_IMAGE_BYTES) { await reader.cancel(); return null; }
      chunks.push(next.value);
    }
  } catch { return null; }
  if (signal.aborted) return null;
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

/** Downloads a small safe avatar and returns a data URL, never partial image data. */
export async function downloadAvatarDataUrl(avatarUrl: string, signal: AbortSignal, fetchAvatar: AvatarFetch = fetch): Promise<string | null> {
  const url = canonicalAvatarUrl(avatarUrl);
  if (!url || signal.aborted) return null;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), AVATAR_TIMEOUT_MS);
  const abort = () => timeout.abort();
  signal.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetchAvatar(url, { signal: timeout.signal, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer' });
    const [contentType = ''] = response.headers.get('content-type')?.split(';', 1) ?? [];
    if (!response.ok || !contentType || !IMAGE_TYPES.has(contentType)) return null;
    const bytes = await readBoundedBody(response, timeout.signal);
    if (!bytes || signal.aborted) return null;
    const dataUrl = `data:${contentType};base64,${base64(bytes)}`;
    return dataUrl.length <= MAX_DATA_URL_CHARS ? dataUrl : null;
  } catch { return null; } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

function profileFromLookup(email: string, lookup: CommitAuthorLookup, fallbackFetchedAt: number): AuthorProfileEntry | null {
  if (!email || email.length > 512 || lookup.resolution === 'unavailable') return null;
  const providedFetchedAt = lookup.fetchedAt;
  const fetchedAt = typeof providedFetchedAt === 'number' && Number.isInteger(providedFetchedAt) && providedFetchedAt >= 0 ? providedFetchedAt : fallbackFetchedAt;
  if (lookup.resolution === 'unlinked') return { v: 1, email, resolution: 'unlinked', login: null, avatarUrl: null, avatarData: null, fetchedAt };
  const author = CommitAuthorSchema.safeParse(lookup.author);
  return author.success ? { v: 1, email, resolution: 'linked', login: author.data.login, avatarUrl: author.data.avatarUrl, avatarData: null, fetchedAt } : null;
}

export function createAuthorProfileCache(options: { storage: Storage; now?: () => number; fetchAvatar?: AvatarFetch }): AuthorProfileCache {
  const now = options.now ?? Date.now;
  const imageFills = new Map<string, Promise<AuthorProfileEntry>>();
  let writes = Promise.resolve();

  const cleanFor = async (prospective: AuthorProfileEntry, preserveKey: string, signal: AbortSignal): Promise<{ expectedCount: number } | null> => {
    if (signal.aborted || byteLength(prospective) > MAX_ENTRY_BYTES) return null;
    let keys: string[];
    try {
      keys = (await options.storage.keys(storageOptions)).filter((key) => key.startsWith(KEY_PREFIX));
    } catch { return null; }
    const otherKeys = keys.filter((key) => key !== preserveKey);
    if (otherKeys.length < SAFE_UNKNOWN_ENTRY_COUNT) return { expectedCount: otherKeys.length + 1 };
    const reads = await Promise.all(otherKeys.map(async (key) => {
      try { return { key, value: await options.storage.get(key, storageOptions) }; } catch { return null; }
    }));
    if (signal.aborted || reads.some((read) => read === null)) return null;
    const candidates: Array<{ key: string; entry: AuthorProfileEntry }> = [];
    const removals: string[] = [];
    for (const read of reads) {
      if (!read) return null;
      const entry = parseEntry(read.value);
      if (!entry || !isFresh(entry, now())) removals.push(read.key);
      else candidates.push({ key: read.key, entry });
    }
    let bytes = byteLength(prospective) + candidates.reduce((total, candidate) => total + byteLength(candidate.entry), 0);
    for (const candidate of [...candidates].sort((left, right) => left.entry.fetchedAt - right.entry.fetchedAt)) {
      if (candidates.length < MAX_ENTRIES && bytes <= MAX_CACHE_BYTES - MAX_ENTRY_BYTES) break;
      removals.push(candidate.key);
      candidates.splice(candidates.indexOf(candidate), 1);
      bytes -= byteLength(candidate.entry);
    }
    if (signal.aborted) return null;
    try { await Promise.all(removals.map(async (key) => { await options.storage.delete(key, storageOptions); })); }
    catch { return null; }
    return signal.aborted ? null : { expectedCount: candidates.length + 1 };
  };

  const persist = async (key: string, entry: AuthorProfileEntry, signal: AbortSignal) => {
    const plan = await cleanFor(entry, key, signal);
    if (!plan || signal.aborted) return;
    try { await options.storage.set(key, entry, storageOptions); }
    catch {
      const retryPlan = await cleanFor(entry, key, signal);
      if (!retryPlan || signal.aborted) return;
      try { await options.storage.set(key, entry, storageOptions); } catch { return; }
    }
    try {
      const count = (await options.storage.keys(storageOptions)).filter((candidate) => candidate.startsWith(KEY_PREFIX)).length;
      if (count > plan.expectedCount) await cleanFor(entry, key, signal);
    } catch { /* A concurrent post-write check is best effort. */ }
  };

  const queueWrite = <T>(task: () => Promise<T>): Promise<T> => {
    const next = writes.then(task, task);
    writes = next.then(() => undefined, () => undefined);
    return next;
  };

  const currentEntry = async (key: string): Promise<AuthorProfileEntry | null> => {
    try { return parseEntry(await options.storage.get(key, storageOptions)); } catch { return null; }
  };

  return {
    async read(email) {
      const normalized = normalizeEmail(email);
      if (!normalized) return null;
      const key = authorProfileKey(normalized);
      try {
        const raw = await options.storage.get(key, storageOptions);
        if (raw === undefined) return null;
        const entry = parseEntry(raw);
        if (!entry) { await options.storage.delete(key, storageOptions).catch(() => undefined); return null; }
        if (entry.email !== normalized) return null;
        if (!isFresh(entry, now())) { await options.storage.delete(key, storageOptions).catch(() => undefined); return null; }
        return entry;
      } catch { return null; }
    },
    async write(email, lookup, signal) {
      const normalized = normalizeEmail(email);
      const entry = normalized && !signal.aborted ? profileFromLookup(normalized, lookup, now()) : null;
      if (!entry || signal.aborted) return null;
      await queueWrite(async () => { await persist(authorProfileKey(normalized), entry, signal); });
      return entry;
    },
    async fillAvatar(entry, signal) {
      if (entry.resolution !== 'linked' || !entry.avatarUrl || entry.avatarData || signal.aborted) return entry;
      const attemptKey = `${entry.email}:${entry.fetchedAt}:${entry.avatarUrl}`;
      const existing = imageFills.get(attemptKey);
      if (existing) return existing;
      const fill = (async () => {
        const avatarData = await downloadAvatarDataUrl(entry.avatarUrl!, signal, options.fetchAvatar);
        if (!avatarData || signal.aborted) return entry;
        const updated = { ...entry, avatarData };
        await queueWrite(async () => {
          if (signal.aborted) return;
          const current = await currentEntry(authorProfileKey(entry.email));
          if (!current || current.resolution !== 'linked' || current.email !== entry.email || current.fetchedAt !== entry.fetchedAt || current.avatarUrl !== entry.avatarUrl || current.avatarData !== null) return;
          await persist(authorProfileKey(entry.email), updated, signal);
        });
        return updated;
      })();
      imageFills.set(attemptKey, fill);
      try { return await fill; } finally { imageFills.delete(attemptKey); }
    },
  };
}
