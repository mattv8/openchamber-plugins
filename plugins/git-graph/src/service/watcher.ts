import { watch, type FSWatcher } from 'node:fs';
import { access } from 'node:fs/promises';
import { basename, join } from 'node:path';

const DEBOUNCE_MS = 300;
const LOCK_RECHECK_MS = 300;
const LEASE_MS = 30 * 60_000;
const REAP_MS = 30_000;

type Timer = unknown;
type WatchFactory = (gitDir: string, listener: (eventType: string, filename: string | Buffer | null) => void) => FSWatcher;
type WatcherOptions = {
  debounceMs?: number;
  retryMs?: number;
  isIndexLocked?: (gitDir: string) => Promise<boolean>;
  schedule?: (callback: () => void, delayMs: number) => Timer;
  cancel?: (timer: Timer) => void;
  watch?: WatchFactory;
};

type Entry = { watcher: FSWatcher; leaseUntil: number; debounceTimer: Timer | undefined; retryTimer: Timer | undefined; pending: boolean };

function isLockFile(filename: string | Buffer | null): boolean {
  return filename !== null && basename(filename.toString()).endsWith('.lock');
}

/** Bounded best-effort change hints. Git remains the snapshot authority. */
export function createRepositoryWatcher(onChange: (repositoryId: string) => void, maxEntries = 20, options: WatcherOptions = {}) {
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  const retryMs = options.retryMs ?? LOCK_RECHECK_MS;
  const schedule: (callback: () => void, delayMs: number) => Timer = options.schedule ?? ((callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return timer;
  });
  const cancel: (timer: Timer) => void = options.cancel ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
  const isIndexLocked = options.isIndexLocked ?? ((gitDir: string) => access(join(gitDir, 'index.lock')).then(() => true).catch(() => false));
  const createWatcher = options.watch ?? watch;
  const entries = new Map<string, Entry>();
  const release = (id: string) => {
    const entry = entries.get(id);
    if (!entry) return;
    if (entry.debounceTimer) cancel(entry.debounceTimer);
    if (entry.retryTimer) cancel(entry.retryTimer);
    entry.watcher.close();
    entries.delete(id);
  };
  const reap = () => {
    const now = Date.now();
    for (const [key, entry] of entries) if (entry.leaseUntil < now) release(key);
  };
  const poll = setInterval(reap, REAP_MS);
  poll.unref();
  const scheduleRetry = (id: string, gitDir: string, entry: Entry) => {
    if (entry.retryTimer) return;
    entry.retryTimer = schedule(() => {
      entry.retryTimer = undefined;
      if (entries.get(id) !== entry) return;
      void refresh(id, gitDir, entry);
    }, retryMs);
  };
  const refresh = async (id: string, gitDir: string, entry: Entry) => {
    if (entries.get(id) !== entry || !entry.pending) return;
    if (await isIndexLocked(gitDir)) {
      if (entries.get(id) === entry) scheduleRetry(id, gitDir, entry);
      return;
    }
    if (entries.get(id) !== entry || !entry.pending) return;
    entry.pending = false;
    onChange(id);
  };
  const scheduleRefresh = (id: string, gitDir: string, entry: Entry) => {
    if (entry.debounceTimer) cancel(entry.debounceTimer);
    if (entry.retryTimer) {
      cancel(entry.retryTimer);
      entry.retryTimer = undefined;
    }
    entry.debounceTimer = schedule(() => {
      entry.debounceTimer = undefined;
      if (entries.get(id) === entry) void refresh(id, gitDir, entry);
    }, debounceMs);
  };
  const ensure = (id: string, gitDir: string) => {
    const now = Date.now();
    for (const [key, entry] of entries) if (entry.leaseUntil < now) release(key);
    const present = entries.get(id);
    if (present) { present.leaseUntil = now + LEASE_MS; return; }
    if (entries.size >= maxEntries) release(entries.keys().next().value as string);
    try {
      const watcher = createWatcher(gitDir, (_eventType, filename) => {
        if (isLockFile(filename)) return;
        const entry = entries.get(id);
        if (!entry) return;
        entry.pending = true;
        scheduleRefresh(id, gitDir, entry);
      });
      watcher.on('error', () => release(id));
      entries.set(id, { watcher, leaseUntil: now + LEASE_MS, debounceTimer: undefined, retryTimer: undefined, pending: false });
    } catch { /* polling/snapshots remain correct if watch is unavailable */ }
  };
  return { ensure, close: () => { clearInterval(poll); [...entries.keys()].forEach(release); } };
}
