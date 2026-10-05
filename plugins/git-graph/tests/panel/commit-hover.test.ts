import { describe, expect, test, afterEach } from 'bun:test';
import { createCommitSummaryCache } from '../../src/panel/commit-hover/cache.js';
import { buildHoverPayload } from '../../src/panel/commit-hover/model.js';
import { CommitHoverPayloadSchema } from '../../src/panel/popover/payload.js';
import { githubCommitUrl, githubRepositoryUrl } from '../../src/panel/commit-hover/remote.js';
import { markMenuOpen, markMenuClosed, isMenuOpen } from '../../src/panel/popover/menu-state.js';
import { hoverMessages } from '../../src/panel/i18n/hover.js';
import { statusMessages } from '../../src/panel/i18n/status.js';
import { menuMessages } from '../../src/panel/i18n/menu.js';

const sha = 'a'.repeat(40);

describe('githubCommitUrl', () => {
  test('prefers origin GitHub fetch URL before its push URL', () => {
    expect(githubRepositoryUrl([{ name: 'origin', fetchUrl: 'https://github.com/owner/fetch.git/', pushUrl: 'git@github.com:owner/push.git' }])).toBe('https://github.com/owner/fetch');
  });

  test('uses an origin push URL or another GitHub remote when origin is not GitHub', () => {
    expect(githubCommitUrl([{ name: 'origin', fetchUrl: 'https://gitlab.example/repo', pushUrl: 'git@github.com:owner/push.git' }, { name: 'upstream', fetchUrl: 'https://github.com/owner/repo.git', pushUrl: null }], sha)).toBe(`https://github.com/owner/push/commit/${sha}`);
    expect(githubCommitUrl([{ name: 'origin', fetchUrl: 'https://gitlab.example/repo', pushUrl: null }, { name: 'upstream', fetchUrl: 'ssh://git@github.com/owner/repo.git', pushUrl: null }], sha)).toBe(`https://github.com/owner/repo/commit/${sha}`);
  });

  test('returns null for non-GitHub remotes', () => expect(githubRepositoryUrl([{ name: 'origin', fetchUrl: 'https://gitlab.example/owner/repo', pushUrl: null }])).toBeNull());
});

describe('createCommitSummaryCache', () => {
  test('coalesces loads, retains positive LRU entries, and expires negative entries', async () => {
    let now = 0;
    let calls = 0;
    const cache = createCommitSummaryCache<string>({ load: async (key) => { calls += 1; if (key === 'bad') throw new Error('nope'); return key; }, now: () => now, maxPositiveEntries: 1 });
    await Promise.all([cache.preload('one'), cache.preload('one')]);
    expect(calls).toBe(1);
    expect(cache.get('one')).toEqual({ status: 'ready', value: 'one' });
    await cache.preload('two');
    expect(cache.get('one')).toEqual({ status: 'idle' });
    await cache.preload('bad');
    await cache.preload('bad');
    expect(calls).toBe(3);
    now = 60_000;
    await cache.preload('bad');
    expect(calls).toBe(4);
  });
});

describe('buildHoverPayload', () => {
  test('trims a summary to the popover character cap without dropping refs', () => {
    const payload = buildHoverPayload({
      id: sha, parentIds: [], subject: 's'.repeat(2_000), message: 'm'.repeat(50_000), author: 'Author', authorEmail: 'author@example.com', timestamp: '2025-01-01T00:00:00Z', statistics: { files: 1, insertions: 2, deletions: 3 }, references: [{ id: 'refs/heads/main', name: 'main', revision: sha, kind: 'local', category: 'branches' }],
    }, [{ id: 'refs/heads/main', name: 'main', revision: sha, kind: 'local', category: 'branches' }], null, { message: 'm'.repeat(50_000), messageTruncated: false, statistics: { files: 1, insertions: 2, deletions: 3 } });
    expect(JSON.stringify(payload).length).toBeLessThanOrEqual(16_000);
    expect(payload.refs).toHaveLength(1);
  });

  test('keeps a schema-valid worst-case reference payload below the host cap', () => {
    const refs = Array.from({ length: 20 }, (_, index) => ({ id: `refs/heads/${index}-${'i'.repeat(180)}`, name: `branch-${'n'.repeat(250)}`, revision: sha, kind: 'local' as const, category: 'branches' as const }));
    const payload = buildHoverPayload({ id: sha, parentIds: [], subject: 'subject', message: 'message', author: 'author', authorEmail: 'author@example.com', timestamp: '2025-01-01T00:00:00Z', statistics: { files: 1, insertions: 0, deletions: 0 }, references: refs }, refs, null, null);
    expect(payload.refs.every((ref) => ref.id.length <= 200 && ref.name.length <= 200)).toBe(true);
    expect(JSON.stringify(payload).length).toBeLessThanOrEqual(16_000);
    expect(CommitHoverPayloadSchema.safeParse(payload).success).toBe(true);
  });
});

describe('menu state and i18n consistency', () => {
  afterEach(() => {
    markMenuClosed('menu-test');
  });

  test('getData throws when menu is open and preload is skipped', () => {
    markMenuOpen('menu-test');
    expect(isMenuOpen()).toBe(true);
    markMenuClosed('menu-test');
    expect(isMenuOpen()).toBe(false);
  });

  test('no duplicate keys across i18n message maps', () => {
    const seenKeys = new Set<string>();
    const allMaps = [statusMessages, hoverMessages, menuMessages];

    for (const map of allMaps) {
      for (const key in map) {
        expect(seenKeys.has(key)).toBe(false);
        seenKeys.add(key);
      }
    }
  });
});
