export type SummaryCacheSnapshot<T> = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; value: T } | { status: 'unavailable' };
type Entry<T> = { snapshot: SummaryCacheSnapshot<T>; promise: Promise<void> | null; expiresAt: number | null };

/** A small LRU cache that avoids duplicate summary reads and retries unavailable entries after a minute. */
export const createCommitSummaryCache = <T>(options: { load(key: string): Promise<T>; now?: () => number; maxPositiveEntries?: number; maxNegativeEntries?: number; negativeTtlMs?: number }) => {
  const entries = new Map<string, Entry<T>>();
  const now = options.now ?? Date.now;
  const positiveLimit = options.maxPositiveEntries ?? 200;
  const negativeLimit = options.maxNegativeEntries ?? 200;
  const negativeTtl = options.negativeTtlMs ?? 60_000;
  const trim = () => {
    const remove = (predicate: (entry: Entry<T>) => boolean, limit: number) => {
      let count = [...entries.values()].filter(predicate).length;
      for (const [key, entry] of entries) {
        if (count <= limit) break;
        if (predicate(entry) && !entry.promise) { entries.delete(key); count -= 1; }
      }
    };
    remove((entry) => entry.snapshot.status === 'ready', positiveLimit);
    remove((entry) => entry.snapshot.status === 'unavailable', negativeLimit);
  };
  const getEntry = (key: string) => {
    const entry = entries.get(key);
    if (entry) return entry;
    const created: Entry<T> = { snapshot: { status: 'idle' }, promise: null, expiresAt: null };
    entries.set(key, created);
    return created;
  };
  return {
    get(key: string): SummaryCacheSnapshot<T> {
      const entry = entries.get(key);
      if (!entry) return { status: 'idle' };
      if (entry.snapshot.status === 'unavailable' && entry.expiresAt !== null && entry.expiresAt <= now()) {
        entry.snapshot = { status: 'idle' }; entry.expiresAt = null;
      }
      if (entry.snapshot.status === 'ready') { entries.delete(key); entries.set(key, entry); }
      return entry.snapshot;
    },
    preload(key: string): Promise<void> {
      const entry = getEntry(key);
      const snapshot = this.get(key);
      if (snapshot.status === 'ready' || snapshot.status === 'unavailable') return Promise.resolve();
      if (entry.promise) return entry.promise;
      entry.snapshot = { status: 'loading' };
      entry.promise = options.load(key).then((value) => {
        entry.snapshot = { status: 'ready', value }; entry.expiresAt = null;
        entries.delete(key); entries.set(key, entry);
      }, () => { entry.snapshot = { status: 'unavailable' }; entry.expiresAt = now() + negativeTtl; }).finally(() => { entry.promise = null; trim(); });
      return entry.promise;
    },
    clear() { entries.clear(); },
  };
};
