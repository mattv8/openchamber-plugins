import { describe, expect, test } from 'bun:test';
import { authorProfileKey, createAuthorProfileCache, downloadAvatarDataUrl } from '../../src/panel/commit-hover/author-profile-cache.js';

type Value = Record<string, unknown>;

class FakeStorage {
  readonly values = new Map<string, Value>();
  readonly deleted: string[] = [];
  failNextSet = false;
  failKeys = false;
  failDelete = false;
  sets = 0;
  gets = 0;

  async get(key: string) { this.gets += 1; return this.values.get(key); }
  async set(key: string, value: Value) {
    if (this.failNextSet) { this.failNextSet = false; throw new Error('full'); }
    this.sets += 1;
    this.values.set(key, value);
  }
  async delete(key: string) { if (this.failDelete) throw new Error('delete failed'); this.deleted.push(key); this.values.delete(key); }
  async keys() { if (this.failKeys) throw new Error('keys failed'); return [...this.values.keys()]; }
}

const linked = { resolution: 'linked' as const, author: { login: 'octocat', avatarUrl: 'https://avatars.githubusercontent.com/u/583231?v=4' } };
const unlinked = { resolution: 'unlinked' as const, author: null };
const png = new Uint8Array([137, 80, 78, 71]);
const largeAvatar = `data:image/png;base64,${'A'.repeat(12_288)}`;
const storedLinked = (email: string, fetchedAt: number, avatarData: string | null = null) => ({ v: 1, email, resolution: 'linked', login: 'octocat', avatarUrl: linked.author.avatarUrl, avatarData, fetchedAt });
const serializedBytes = (values: Iterable<Value>) => [...values].reduce((total, value) => total + new TextEncoder().encode(JSON.stringify(value)).byteLength, 0);

describe('author profile cache', () => {
  test('normalizes the email before deriving an opaque per-author key', () => {
    expect(authorProfileKey('  USER@Example.Test ')).toBe(authorProfileKey('user@example.test'));
    expect(authorProfileKey('user@example.test')).toMatch(/^author-profile:v1:[0-9a-f]{16}$/);
  });

  test('persists and restores a linked profile across cache instances', async () => {
    const storage = new FakeStorage();
    const first = createAuthorProfileCache({ storage, now: () => 100 });
    await first.write('User@example.test', linked, new AbortController().signal);
    const result = await createAuthorProfileCache({ storage, now: () => 200 }).read('user@example.test');
    expect(result).toMatchObject({ resolution: 'linked', login: 'octocat', avatarUrl: linked.author.avatarUrl, fetchedAt: 100 });
  });

  test('retains a definitive unlinked result', async () => {
    const storage = new FakeStorage();
    const cache = createAuthorProfileCache({ storage, now: () => 100 });
    await cache.write('user@example.test', unlinked, new AbortController().signal);
    expect(await cache.read('user@example.test')).toMatchObject({ resolution: 'unlinked', login: null, avatarUrl: null });
  });

  test('does not persist unavailable lookups or empty emails', async () => {
    const storage = new FakeStorage();
    const cache = createAuthorProfileCache({ storage });
    await cache.write('', { resolution: 'unavailable', author: null }, new AbortController().signal);
    await cache.write('user@example.test', { resolution: 'unavailable', author: null }, new AbortController().signal);
    expect(storage.values.size).toBe(0);
  });

  test('expires fixed TTL entries and rejects future timestamps', async () => {
    const storage = new FakeStorage();
    const key = authorProfileKey('user@example.test');
    storage.values.set(key, { v: 1, email: 'user@example.test', resolution: 'linked', login: 'octocat', avatarUrl: linked.author.avatarUrl, avatarData: null, fetchedAt: 0 });
    expect(await createAuthorProfileCache({ storage, now: () => 86_400_000 }).read('user@example.test')).toBeNull();
    storage.values.set(key, { v: 1, email: 'user@example.test', resolution: 'linked', login: 'octocat', avatarUrl: linked.author.avatarUrl, avatarData: null, fetchedAt: 300_001 });
    expect(await createAuthorProfileCache({ storage, now: () => 0 }).read('user@example.test')).toBeNull();
  });

  test('does not delete a valid entry belonging to a colliding email', async () => {
    const storage = new FakeStorage();
    const key = authorProfileKey('user@example.test');
    storage.values.set(key, { v: 1, email: 'other@example.test', resolution: 'linked', login: 'octocat', avatarUrl: linked.author.avatarUrl, avatarData: null, fetchedAt: 0 });
    expect(await createAuthorProfileCache({ storage, now: () => 1 }).read('user@example.test')).toBeNull();
    expect(storage.deleted).toEqual([]);
  });

  test('deletes malformed records rather than returning unsafe cached profile data', async () => {
    const storage = new FakeStorage();
    const key = authorProfileKey('user@example.test');
    storage.values.set(key, { v: 1, email: 'user@example.test', resolution: 'linked', login: 'octocat', avatarUrl: 'https://example.test/avatar.png', avatarData: null, fetchedAt: 0 });
    expect(await createAuthorProfileCache({ storage, now: () => 1 }).read('user@example.test')).toBeNull();
    expect(storage.deleted).toEqual([key]);
  });

  test('does not delete an absent cache key', async () => {
    const storage = new FakeStorage();
    expect(await createAuthorProfileCache({ storage }).read('missing@example.test')).toBeNull();
    expect(storage.deleted).toEqual([]);
  });

  test('cleans old profile records before retrying a full write without touching other keys', async () => {
    const storage = new FakeStorage();
    storage.values.set('other:record', { retained: true });
    storage.values.set(authorProfileKey('old@example.test'), { v: 1, email: 'old@example.test', resolution: 'unlinked', login: null, avatarUrl: null, avatarData: null, fetchedAt: 0 });
    storage.failNextSet = true;
    await createAuthorProfileCache({ storage, now: () => 1 }).write('new@example.test', linked, new AbortController().signal);
    expect(storage.values.get('other:record')).toEqual({ retained: true });
    expect(storage.values.has(authorProfileKey('new@example.test'))).toBeTrue();
  });

  test('prunes oldest entries before a prospective write exceeds the one MiB profile budget', async () => {
    const storage = new FakeStorage();
    for (let index = 0; index < 100; index += 1) {
      const email = `${index}@example.test`;
      storage.values.set(authorProfileKey(email), storedLinked(email, index, largeAvatar));
    }
    await createAuthorProfileCache({ storage, now: () => 200 }).write('new@example.test', linked, new AbortController().signal);
    expect(storage.values.has(authorProfileKey('new@example.test'))).toBeTrue();
    expect(storage.values.size).toBeLessThanOrEqual(100);
    expect(storage.values.has(authorProfileKey('0@example.test'))).toBeFalse();
    expect(serializedBytes(storage.values.values())).toBeLessThanOrEqual(1_024 * 1_024);
  });

  test('skips writes when profile enumeration or required pruning fails', async () => {
    const keysFailed = new FakeStorage();
    keysFailed.failKeys = true;
    await createAuthorProfileCache({ storage: keysFailed }).write('user@example.test', linked, new AbortController().signal);
    expect(keysFailed.sets).toBe(0);
    const deleteFailed = new FakeStorage();
    deleteFailed.values.set(authorProfileKey('old@example.test'), storedLinked('old@example.test', 0));
    for (let index = 0; index < 15; index += 1) deleteFailed.values.set(authorProfileKey(`valid${index}@example.test`), storedLinked(`valid${index}@example.test`, 86_399_999));
    deleteFailed.failDelete = true;
    await createAuthorProfileCache({ storage: deleteFailed, now: () => 86_400_000 }).write('user@example.test', linked, new AbortController().signal);
    expect(deleteFailed.sets).toBe(0);
  });

  test('serializes concurrent same-instance profile writes within the entry cap', async () => {
    const storage = new FakeStorage();
    const cache = createAuthorProfileCache({ storage, now: () => 1 });
    await Promise.all(Array.from({ length: 101 }, (_value, index) => cache.write(`${index}@example.test`, linked, new AbortController().signal)));
    expect(storage.values.size).toBeLessThanOrEqual(100);
  });

  test('writes through a fresh cache with a small profile key count without reading stored values', async () => {
    const storage = new FakeStorage();
    for (let index = 0; index < 5; index += 1) storage.values.set(authorProfileKey(`${index}@example.test`), storedLinked(`${index}@example.test`, index));
    await createAuthorProfileCache({ storage, now: () => 100 }).write('new@example.test', linked, new AbortController().signal);
    expect(storage.gets).toBe(0);
  });

  test('reads seeded profiles once during one cleanup pass instead of before and after every write', async () => {
    const storage = new FakeStorage();
    for (let index = 0; index < 51; index += 1) storage.values.set(authorProfileKey(`${index}@example.test`), storedLinked(`${index}@example.test`, index));
    await createAuthorProfileCache({ storage, now: () => 100 }).write('new@example.test', linked, new AbortController().signal);
    expect(storage.gets).toBeLessThanOrEqual(51);
  });

  test('separate cache instances keep concurrent writes within the local cleanup headroom', async () => {
    const storage = new FakeStorage();
    for (let index = 0; index < 99; index += 1) storage.values.set(authorProfileKey(`${index}@example.test`), storedLinked(`${index}@example.test`, index));
    await Promise.all([
      createAuthorProfileCache({ storage, now: () => 100 }).write('left@example.test', linked, new AbortController().signal),
      createAuthorProfileCache({ storage, now: () => 100 }).write('right@example.test', linked, new AbortController().signal),
    ]);
    expect(storage.values.size).toBeLessThanOrEqual(100);
  });

  test('downloads only a canonical GitHub avatar with safe fetch options and a bounded data URL', async () => {
    let request: RequestInit | undefined;
    let url = '';
    const result = await downloadAvatarDataUrl('https://avatars.githubusercontent.com/u/583231?v=4&ignored=yes', new AbortController().signal, async (input, init) => {
      url = input;
      request = init;
      return new Response(png, { headers: { 'content-type': 'image/png' } });
    });
    expect(result).toBe('data:image/png;base64,iVBORw==');
    expect(url).toBe('https://avatars.githubusercontent.com/u/583231?v=4&s=40');
    expect(request).toMatchObject({ redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer' });
  });

  test('rejects invalid types, oversized streams, and aborts without returning partial image data', async () => {
    const controller = new AbortController();
    const wrongType = downloadAvatarDataUrl('https://avatars.githubusercontent.com/u/583231', controller.signal, async () => new Response(png, { headers: { 'content-type': 'image/svg+xml' } }));
    expect(await wrongType).toBeNull();
    const tooLarge = await downloadAvatarDataUrl('https://avatars.githubusercontent.com/u/583231', controller.signal, async () => new Response(new ReadableStream({ start(stream) { stream.enqueue(new Uint8Array(9_217)); stream.close(); } }), { headers: { 'content-type': 'image/png' } }));
    expect(tooLarge).toBeNull();
    const oversizedHeader = await downloadAvatarDataUrl('https://avatars.githubusercontent.com/u/583231', controller.signal, async () => new Response(png, { headers: { 'content-type': 'image/png', 'content-length': '9217' } }));
    expect(oversizedHeader).toBeNull();
    controller.abort();
    expect(await downloadAvatarDataUrl('https://avatars.githubusercontent.com/u/583231', controller.signal, async () => new Response(png, { headers: { 'content-type': 'image/png' } }))).toBeNull();
  });

  test('rejects noncanonical avatar URLs before requesting them', async () => {
    let calls = 0;
    for (const url of ['http://avatars.githubusercontent.com/u/583231', 'https://avatars.githubusercontent.com/u/not-a-number', 'https://avatars.githubusercontent.com.evil.test/u/583231', 'https://user@avatars.githubusercontent.com/u/583231']) {
      expect(await downloadAvatarDataUrl(url, new AbortController().signal, async () => { calls += 1; return new Response(png); })).toBeNull();
    }
    expect(calls).toBe(0);
  });

  test('times out an avatar request after five seconds', async () => {
    let timedOut = false;
    const result = await downloadAvatarDataUrl('https://avatars.githubusercontent.com/u/583231', new AbortController().signal, async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { timedOut = true; reject(new Error('aborted')); }, { once: true });
    }));
    expect(result).toBeNull();
    expect(timedOut).toBeTrue();
  }, 6_000);

  test('fills a missing avatar without extending the profile TTL and keeps the profile when download fails', async () => {
    const storage = new FakeStorage();
    const cache = createAuthorProfileCache({ storage, now: () => 100, fetchAvatar: async () => new Response(png, { headers: { 'content-type': 'image/png' } }) });
    await cache.write('user@example.test', linked, new AbortController().signal);
    const profile = await cache.read('user@example.test');
    if (!profile) throw new Error('missing profile');
    expect(await cache.fillAvatar(profile, new AbortController().signal)).toMatchObject({ avatarData: 'data:image/png;base64,iVBORw==', fetchedAt: 100 });
    const noImage = createAuthorProfileCache({ storage: new FakeStorage(), fetchAvatar: async () => { throw new Error('offline'); } });
    await noImage.write('user@example.test', linked, new AbortController().signal);
    const profileWithoutImage = await noImage.read('user@example.test');
    if (!profileWithoutImage) throw new Error('missing profile');
    expect(await noImage.fillAvatar(profileWithoutImage, new AbortController().signal)).toMatchObject({ avatarData: null, login: 'octocat' });
  });

  test('does not overwrite a newer profile when a stale avatar download completes', async () => {
    const storage = new FakeStorage();
    let resolveFetch: ((response: Response) => void) | undefined;
    const cache = createAuthorProfileCache({ storage, now: () => 100, fetchAvatar: async () => new Promise<Response>((resolve) => { resolveFetch = resolve; }) });
    await cache.write('user@example.test', linked, new AbortController().signal);
    const profile = await cache.read('user@example.test');
    if (!profile) throw new Error('missing profile');
    const filling = cache.fillAvatar(profile, new AbortController().signal);
    await cache.write('user@example.test', { ...linked, fetchedAt: 101 }, new AbortController().signal);
    resolveFetch?.(new Response(png, { headers: { 'content-type': 'image/png' } }));
    await filling;
    expect((await cache.read('user@example.test'))?.avatarData).toBeNull();
  });

  test('retries an avatar download after an aborted attempt', async () => {
    const storage = new FakeStorage();
    let calls = 0;
    const cache = createAuthorProfileCache({ storage, fetchAvatar: async () => { calls += 1; return new Response(png, { headers: { 'content-type': 'image/png' } }); } });
    await cache.write('user@example.test', linked, new AbortController().signal);
    const profile = await cache.read('user@example.test');
    if (!profile) throw new Error('missing profile');
    const aborted = new AbortController();
    aborted.abort();
    await cache.fillAvatar(profile, aborted.signal);
    expect((await cache.fillAvatar(profile, new AbortController().signal)).avatarData).not.toBeNull();
    expect(calls).toBe(1);
  });
});
