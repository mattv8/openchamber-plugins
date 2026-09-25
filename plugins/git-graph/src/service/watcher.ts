import { watch, type FSWatcher } from 'node:fs';

/** Bounded best-effort change hints. Git remains the snapshot authority. */
export function createRepositoryWatcher(onChange: (repositoryId: string) => void, maxEntries = 20) {
  const entries = new Map<string, { watcher: FSWatcher; leaseUntil: number }>();
  const release = (id: string) => {
    const entry = entries.get(id);
    if (!entry) return;
    entry.watcher.close();
    entries.delete(id);
  };
  const reap = () => {
    const now = Date.now();
    for (const [key, entry] of entries) if (entry.leaseUntil < now) release(key);
  };
  const poll = setInterval(reap, 30_000);
  poll.unref();
  const ensure = (id: string, gitDir: string) => {
    const now = Date.now();
    for (const [key, entry] of entries) if (entry.leaseUntil < now) release(key);
    const present = entries.get(id);
    if (present) { present.leaseUntil = now + 30 * 60_000; return; }
    if (entries.size >= maxEntries) release(entries.keys().next().value as string);
    try {
      const watcher = watch(gitDir, () => onChange(id));
      watcher.on('error', () => release(id));
      entries.set(id, { watcher, leaseUntil: now + 30 * 60_000 });
    } catch { /* polling/snapshots remain correct if watch is unavailable */ }
  };
  return { ensure, close: () => { clearInterval(poll); [...entries.keys()].forEach(release); } };
}
