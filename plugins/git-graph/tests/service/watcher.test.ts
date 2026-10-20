import { describe, expect, test } from 'bun:test';
import type { FSWatcher } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositoryWatcher } from '../../src/service/watcher.js';

type Scheduled = { callback: () => void; cancelled: boolean };

function fixture(locked = new Set<string>()) {
  const callbacks = new Map<string, (eventType: string, filename: string | null) => void>();
  const scheduled: Scheduled[] = [];
  const changes: string[] = [];
  const watcher = createRepositoryWatcher((id) => changes.push(id), 2, {
    debounceMs: 300,
    retryMs: 50,
    isIndexLocked: async (gitDir) => locked.has(gitDir),
    schedule: (callback) => {
      const timer = { callback, cancelled: false };
      scheduled.push(timer);
      return timer;
    },
    cancel: (timer) => {
      const scheduledTimer = scheduled.find((candidate) => candidate === timer);
      if (scheduledTimer) scheduledTimer.cancelled = true;
    },
    watch: (gitDir, callback) => {
      callbacks.set(gitDir, callback);
      return { close: () => callbacks.delete(gitDir), on: () => undefined } as unknown as FSWatcher;
    },
  });
  const flush = async () => {
    const due = scheduled.length;
    for (let index = 0; index < due; index += 1) {
      const timer = scheduled.shift()!;
      if (!timer.cancelled) await timer.callback();
    }
  };
  const flushOne = async () => {
    const timer = scheduled.shift();
    if (timer && !timer.cancelled) await timer.callback();
  };
  return { callbacks, changes, flush, flushOne, locked, watcher };
}

describe('repository watcher', () => {
  test('delivers a real filesystem hint for a non-lock file', async () => {
    const gitDir = await mkdtemp(join(tmpdir(), 'git-graph-watch-'));
    let resolveChange: (() => void) | undefined;
    const changed = new Promise<void>((resolve) => { resolveChange = resolve; });
    const watcher = createRepositoryWatcher(() => resolveChange?.());

    try {
      watcher.ensure('one', gitDir);
      await writeFile(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
      await Promise.race([
        changed,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('filesystem watcher did not deliver HEAD change')), 2_000)),
      ]);
    } finally {
      watcher.close();
      await rm(gitDir, { recursive: true, force: true });
    }
  });

  test('ignores lock-only hints but accepts a later legitimate sentinel', async () => {
    const test = fixture();
    test.watcher.ensure('one', '/repo/one');
    test.callbacks.get('/repo/one')!('rename', 'index.lock');
    await test.flush();
    expect(test.changes).toEqual([]);

    test.callbacks.get('/repo/one')!('change', 'HEAD');
    await test.flush();
    expect(test.changes).toEqual(['one']);
    test.watcher.close();
  });

  test('coalesces bursts per repository and treats unknown filenames as hints', async () => {
    const test = fixture();
    test.watcher.ensure('one', '/repo/one');
    const hint = test.callbacks.get('/repo/one')!;
    hint('change', 'HEAD');
    hint('change', null);
    hint('rename', 'refs');
    await test.flush();
    expect(test.changes).toEqual(['one']);
    test.watcher.close();
  });

  test('rechecks a locked repository and resumes after the lock clears without another event', async () => {
    const locked = new Set(['/repo/one']);
    const test = fixture(locked);
    test.watcher.ensure('one', '/repo/one');
    test.callbacks.get('/repo/one')!('change', 'HEAD');
    await test.flush();
    expect(test.changes).toEqual([]);

    locked.delete('/repo/one');
    await test.flush();
    expect(test.changes).toEqual(['one']);
    test.watcher.close();
  });

  test('does not let a prior lock recheck bypass a newer trailing debounce', async () => {
    const locked = new Set(['/repo/one']);
    const test = fixture(locked);
    test.watcher.ensure('one', '/repo/one');
    const hint = test.callbacks.get('/repo/one')!;
    hint('change', 'HEAD');
    await test.flush();
    locked.delete('/repo/one');
    hint('change', 'refs');

    await test.flushOne();
    expect(test.changes).toEqual([]);
    await test.flush();
    expect(test.changes).toEqual(['one']);
    test.watcher.close();
  });

  test('keeps one locked repository from delaying another', async () => {
    const locked = new Set(['/repo/one']);
    const test = fixture(locked);
    test.watcher.ensure('one', '/repo/one');
    test.watcher.ensure('two', '/repo/two');
    test.callbacks.get('/repo/one')!('change', 'HEAD');
    test.callbacks.get('/repo/two')!('change', 'HEAD');
    await test.flush();
    expect(test.changes).toEqual(['two']);
    test.watcher.close();
  });

  test('cancels pending work when FIFO eviction or close releases an entry', async () => {
    const test = fixture();
    test.watcher.ensure('one', '/repo/one');
    test.callbacks.get('/repo/one')!('change', 'HEAD');
    test.watcher.ensure('two', '/repo/two');
    test.watcher.ensure('three', '/repo/three');
    await test.flush();
    expect(test.changes).toEqual([]);
    test.watcher.close();
  });
});
