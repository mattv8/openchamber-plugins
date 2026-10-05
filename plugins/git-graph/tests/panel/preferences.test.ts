import { describe, expect, test } from 'bun:test';
import type { JsonValue } from '@openchamber/sdk';
import { readGraphPrefs, writeGraphPrefs, type GraphPrefs } from '../../src/panel/state/preferences.js';

type FakeHost = { storage: { get: (k: string, opts?: { scope?: 'instance' | 'device' }) => Promise<JsonValue | undefined>; set: (k: string, v: JsonValue, opts?: { scope?: 'instance' | 'device' }) => Promise<void>; delete: (k: string, opts?: { scope?: 'instance' | 'device' }) => Promise<void> } };

// FNV-1a hash function matching StatusSection
function fnv1aHash(directory: string): string {
  let hash = 2166136261;
  for (let index = 0; index < directory.length; index += 1) {
    hash = Math.imul(hash ^ directory.charCodeAt(index), 16777619);
  }
  return (hash >>> 0).toString(36);
}

// Fake storage double that records all operations
class FakeStorageDouble {
  private data: Map<string, JsonValue> = new Map();
  private operations: Array<{ op: 'get' | 'set' | 'delete'; key: string; scope: 'instance' | 'device'; value?: unknown }> = [];
  private rejectNextOperation = false;
  private invalidJsonKey: string | null = null;

  get callCount() {
    return this.operations.length;
  }

  getOperations() {
    return [...this.operations];
  }

  recordReject() {
    this.rejectNextOperation = true;
  }

  recordInvalidJson(key: string) {
    this.invalidJsonKey = key;
  }

  async get(key: string, opts?: { scope?: 'instance' | 'device' }) {
    const scope = opts?.scope ?? 'instance';
    this.operations.push({ op: 'get', key, scope });
    if (this.rejectNextOperation) {
      this.rejectNextOperation = false;
      throw new Error('Storage rejection');
    }
    if (this.invalidJsonKey === key) {
      this.invalidJsonKey = null;
      return '{ invalid json ';
    }
    return this.data.get(key);
  }

  async set(key: string, value: JsonValue, opts?: { scope?: 'instance' | 'device' }) {
    const scope = opts?.scope ?? 'instance';
    this.operations.push({ op: 'set', key, scope, value });
    if (this.rejectNextOperation) {
      this.rejectNextOperation = false;
      throw new Error('Storage rejection');
    }
    this.data.set(key, value);
  }

  async delete(key: string, opts?: { scope?: 'instance' | 'device' }) {
    const scope = opts?.scope ?? 'instance';
    this.operations.push({ op: 'delete', key, scope });
    if (this.rejectNextOperation) {
      this.rejectNextOperation = false;
      throw new Error('Storage rejection');
    }
    this.data.delete(key);
  }

  clearOperations() {
    this.operations = [];
  }
}

describe('preferences', () => {
  test('returns default when no preferences are stored and deviceStorage=false', async () => {
    const storage = new FakeStorageDouble();
    const host: FakeHost = { storage: { get: (k: string, opts?: { scope?: 'instance' | 'device' }) => storage.get(k, opts), set: (k: string, v: JsonValue, opts?: { scope?: 'instance' | 'device' }) => storage.set(k, v, opts), delete: (k: string, opts?: { scope?: 'instance' | 'device' }) => storage.delete(k, opts) } };

    const result = await readGraphPrefs(host, '/repo/path', false);

    expect(result.source).toBe('default');
    expect(result.prefs).toEqual({ mode: 'auto', refs: [] });
    const ops = storage.getOperations();
    expect(ops).toHaveLength(1);
    expect(ops[0]?.op).toBe('get');
    expect(ops[0]?.key).toBe(`status:${fnv1aHash('/repo/path')}`);
    expect(ops[0]?.scope).toBe('instance');
  });

  test('reads legacy instance key when deviceStorage=false', async () => {
    const storage = new FakeStorageDouble();
    const host: FakeHost = { storage: { get: (k: string, opts?: { scope?: 'instance' | 'device' }) => storage.get(k, opts), set: (k: string, v: JsonValue, opts?: { scope?: 'instance' | 'device' }) => storage.set(k, v, opts), delete: (k: string, opts?: { scope?: 'instance' | 'device' }) => storage.delete(k, opts) } };
    const hash = fnv1aHash('/repo/path');
    const legacyPrefs = { mode: 'all' as const, refs: ['ref1', 'ref2'] };
    await storage.set(`status:${hash}`, legacyPrefs, { scope: 'instance' });
    storage.clearOperations();

    const result = await readGraphPrefs(host, '/repo/path', false);

    expect(result.source).toBe('legacy');
    expect(result.prefs).toEqual(legacyPrefs);
  });

  test('throws on invalid JSON in legacy key when deviceStorage=false', async () => {
    const storage = new FakeStorageDouble();
    const host: FakeHost = { storage: { get: (k: string, opts?: { scope?: 'instance' | 'device' }) => storage.get(k, opts), set: (k: string, v: JsonValue, opts?: { scope?: 'instance' | 'device' }) => storage.set(k, v, opts), delete: (k: string, opts?: { scope?: 'instance' | 'device' }) => storage.delete(k, opts) } };
    const hash = fnv1aHash('/repo/path');
    storage.recordInvalidJson(`status:${hash}`);

    try {
      await readGraphPrefs(host, '/repo/path', false);
      throw new Error('Should have thrown');
    } catch (error) {
      expect(error instanceof Error && error.message).toMatch(/JSON|invalid/i);
    }
  });

  test('throws on storage rejection when deviceStorage=false', async () => {
    const storage = new FakeStorageDouble();
    const host: FakeHost = { storage: { get: (k: string, opts?: { scope?: 'instance' | 'device' }) => storage.get(k, opts), set: (k: string, v: JsonValue, opts?: { scope?: 'instance' | 'device' }) => storage.set(k, v, opts), delete: (k: string, opts?: { scope?: 'instance' | 'device' }) => storage.delete(k, opts) } };
    storage.recordReject();

    try {
      await readGraphPrefs(host, '/repo/path', false);
      throw new Error('Should have thrown');
    } catch (error) {
      expect(error instanceof Error && error.message).toMatch(/rejection|error/i);
    }
  });

  test('reads device key first when deviceStorage=true', async () => {
    const storage = new FakeStorageDouble();
    const host: FakeHost = { storage: { get: (k: string, opts?: { scope?: 'instance' | 'device' }) => storage.get(k, opts), set: (k: string, v: JsonValue, opts?: { scope?: 'instance' | 'device' }) => storage.set(k, v, opts), delete: (k: string, opts?: { scope?: 'instance' | 'device' }) => storage.delete(k, opts) } };
    const hash = fnv1aHash('/repo/path');
    const devicePrefs = { mode: 'manual' as const, refs: ['ref1'] };
    await storage.set(`prefs:${hash}`, devicePrefs, { scope: 'device' });
    storage.clearOperations();

    const result = await readGraphPrefs(host, '/repo/path', true);

    expect(result.source).toBe('device');
    expect(result.prefs).toEqual(devicePrefs);
    const ops = storage.getOperations();
    expect(ops[0]?.key).toBe(`prefs:${hash}`);
    expect(ops[0]?.scope).toBe('device');
  });

  test('falls back to legacy when device key absent and deviceStorage=true', async () => {
    const storage = new FakeStorageDouble();
    const host: FakeHost = { storage: { get: (k: string, opts?: { scope?: 'instance' | 'device' }) => storage.get(k, opts), set: (k: string, v: JsonValue, opts?: { scope?: 'instance' | 'device' }) => storage.set(k, v, opts), delete: (k: string, opts?: { scope?: 'instance' | 'device' }) => storage.delete(k, opts) } };
    const hash = fnv1aHash('/repo/path');
    const legacyPrefs = { mode: 'all' as const, refs: ['ref1'] };
    await storage.set(`status:${hash}`, legacyPrefs, { scope: 'instance' });
    storage.clearOperations();

    const result = await readGraphPrefs(host, '/repo/path', true);

    expect(result.source).toBe('legacy');
    expect(result.prefs).toEqual(legacyPrefs);
    const ops = storage.getOperations();
    // Should have: device get, legacy get, device set (copy-to-device)
    expect(ops.filter((op) => op.op === 'get')).toHaveLength(2);
    expect(ops[0]?.key).toBe(`prefs:${hash}`);
    expect(ops[1]?.key).toBe(`status:${hash}`);
  });

  test('copies valid legacy to device and returns legacy source when deviceStorage=true', async () => {
    const storage = new FakeStorageDouble();
    const host: FakeHost = { storage: { get: (k: string, opts?: { scope?: 'instance' | 'device' }) => storage.get(k, opts), set: (k: string, v: JsonValue, opts?: { scope?: 'instance' | 'device' }) => storage.set(k, v, opts), delete: (k: string, opts?: { scope?: 'instance' | 'device' }) => storage.delete(k, opts) } };
    const hash = fnv1aHash('/repo/path');
    const legacyPrefs = { mode: 'all' as const, refs: ['ref1', 'ref2'] };
    await storage.set(`status:${hash}`, legacyPrefs, { scope: 'instance' });
    storage.clearOperations();

    const result = await readGraphPrefs(host, '/repo/path', true);

    expect(result.source).toBe('legacy');
    expect(result.prefs).toEqual(legacyPrefs);
    const ops = storage.getOperations();
    // Should have: device get, legacy get, device set
    const deviceSet = ops.find((op) => op.op === 'set' && op.scope === 'device');
    expect(deviceSet).toBeDefined();
    expect(deviceSet?.value).toEqual(legacyPrefs);
  });

  test('returns legacy source even if copy to device fails when deviceStorage=true', async () => {
    const storage = new FakeStorageDouble();
    const hostStorage = {
      get: async (k: string, opts?: { scope?: 'instance' | 'device' }) => storage.get(k, opts),
      set: async (k: string, v: JsonValue, opts?: { scope?: 'instance' | 'device' }) => {
        // Fail only on device write (the copy-to-device in readGraphPrefs)
        if (opts?.scope === 'device') throw new Error('Storage rejection');
        return storage.set(k, v, opts);
      },
      delete: async (k: string, opts?: { scope?: 'instance' | 'device' }) => storage.delete(k, opts),
    };
    const host = { storage: hostStorage };
    const hash = fnv1aHash('/repo/path');
    const legacyPrefs = { mode: 'all' as const, refs: ['ref1'] };
    await storage.set(`status:${hash}`, legacyPrefs, { scope: 'instance' });
    storage.clearOperations();

    const result = await readGraphPrefs(host, '/repo/path', true);

    // Still returns legacy source despite copy failure
    expect(result.source).toBe('legacy');
    expect(result.prefs).toEqual(legacyPrefs);
  });

  test('returns default when both device and legacy absent and deviceStorage=true', async () => {
    const storage = new FakeStorageDouble();
    const host: FakeHost = { storage: { get: (k: string, opts?: { scope?: 'instance' | 'device' }) => storage.get(k, opts), set: (k: string, v: JsonValue, opts?: { scope?: 'instance' | 'device' }) => storage.set(k, v, opts), delete: (k: string, opts?: { scope?: 'instance' | 'device' }) => storage.delete(k, opts) } };

    const result = await readGraphPrefs(host, '/repo/path', true);

    expect(result.source).toBe('default');
    expect(result.prefs).toEqual({ mode: 'auto', refs: [] });
  });

  test('throws on invalid JSON in device key when deviceStorage=true', async () => {
    const storage = new FakeStorageDouble();
    const host: FakeHost = { storage: { get: (k: string, opts?: { scope?: 'instance' | 'device' }) => storage.get(k, opts), set: (k: string, v: JsonValue, opts?: { scope?: 'instance' | 'device' }) => storage.set(k, v, opts), delete: (k: string, opts?: { scope?: 'instance' | 'device' }) => storage.delete(k, opts) } };
    const hash = fnv1aHash('/repo/path');
    storage.recordInvalidJson(`prefs:${hash}`);

    try {
      await readGraphPrefs(host, '/repo/path', true);
      throw new Error('Should have thrown');
    } catch (error) {
      expect(error instanceof Error && error.message).toMatch(/JSON|invalid/i);
    }
  });

  test('throws on storage rejection when deviceStorage=true', async () => {
    const storage = new FakeStorageDouble();
    const host: FakeHost = { storage: { get: (k: string, opts?: { scope?: 'instance' | 'device' }) => storage.get(k, opts), set: (k: string, v: JsonValue, opts?: { scope?: 'instance' | 'device' }) => storage.set(k, v, opts), delete: (k: string, opts?: { scope?: 'instance' | 'device' }) => storage.delete(k, opts) } };
    storage.recordReject();

    try {
      await readGraphPrefs(host, '/repo/path', true);
      throw new Error('Should have thrown');
    } catch (error) {
      expect(error instanceof Error && error.message).toMatch(/rejection|error/i);
    }
  });

  test('caps refs at 32 on write', async () => {
    const storage = new FakeStorageDouble();
    const host: FakeHost = { storage: { get: (k: string, opts?: { scope?: 'instance' | 'device' }) => storage.get(k, opts), set: (k: string, v: JsonValue, opts?: { scope?: 'instance' | 'device' }) => storage.set(k, v, opts), delete: (k: string, opts?: { scope?: 'instance' | 'device' }) => storage.delete(k, opts) } };
    const refs = Array.from({ length: 40 }, (_, i) => `ref${i}`);
    const prefs: GraphPrefs = { mode: 'manual', refs };

    await writeGraphPrefs(host, '/repo/path', prefs, false);

    const ops = storage.getOperations();
    const setOp = ops.find((op) => op.op === 'set');
    expect(setOp?.op).toBe('set');
    const writtenValue = setOp?.value as GraphPrefs | undefined;
    expect(writtenValue?.mode).toBe('manual');
    expect(writtenValue?.refs).toHaveLength(32);
  });

  test('writes to instance scope when deviceStorage=false', async () => {
    const storage = new FakeStorageDouble();
    const host: FakeHost = { storage: { get: (k: string, opts?: { scope?: 'instance' | 'device' }) => storage.get(k, opts), set: (k: string, v: JsonValue, opts?: { scope?: 'instance' | 'device' }) => storage.set(k, v, opts), delete: (k: string, opts?: { scope?: 'instance' | 'device' }) => storage.delete(k, opts) } };
    const prefs: GraphPrefs = { mode: 'auto', refs: [] };

    await writeGraphPrefs(host, '/repo/path', prefs, false);

    const hash = fnv1aHash('/repo/path');
    const ops = storage.getOperations();
    expect(ops).toHaveLength(1);
    expect(ops[0]?.op).toBe('set');
    expect(ops[0]?.key).toBe(`status:${hash}`);
    expect(ops[0]?.scope).toBe('instance');
  });

  test('writes to device scope when deviceStorage=true', async () => {
    const storage = new FakeStorageDouble();
    const host: FakeHost = { storage: { get: (k: string, opts?: { scope?: 'instance' | 'device' }) => storage.get(k, opts), set: (k: string, v: JsonValue, opts?: { scope?: 'instance' | 'device' }) => storage.set(k, v, opts), delete: (k: string, opts?: { scope?: 'instance' | 'device' }) => storage.delete(k, opts) } };
    const prefs: GraphPrefs = { mode: 'auto', refs: [] };

    await writeGraphPrefs(host, '/repo/path', prefs, true);

    const hash = fnv1aHash('/repo/path');
    const ops = storage.getOperations();
    expect(ops).toHaveLength(1);
    expect(ops[0]?.op).toBe('set');
    expect(ops[0]?.key).toBe(`prefs:${hash}`);
    expect(ops[0]?.scope).toBe('device');
  });

  test('rejects when write fails', async () => {
    const storage = new FakeStorageDouble();
    const host: FakeHost = { storage: { get: (k: string, opts?: { scope?: 'instance' | 'device' }) => storage.get(k, opts), set: (k: string, v: JsonValue, opts?: { scope?: 'instance' | 'device' }) => storage.set(k, v, opts), delete: (k: string, opts?: { scope?: 'instance' | 'device' }) => storage.delete(k, opts) } };
    const prefs: GraphPrefs = { mode: 'auto', refs: [] };
    storage.recordReject();

    try {
      await writeGraphPrefs(host, '/repo/path', prefs, false);
      throw new Error('Should have thrown');
    } catch (error) {
      expect(error instanceof Error && error.message).toMatch(/rejection|error/i);
    }
  });

  test('validates against Zod schema with strict mode', async () => {
    const storage = new FakeStorageDouble();
    const host: FakeHost = { storage: { get: (k: string, opts?: { scope?: 'instance' | 'device' }) => storage.get(k, opts), set: (k: string, v: JsonValue, opts?: { scope?: 'instance' | 'device' }) => storage.set(k, v, opts), delete: (k: string, opts?: { scope?: 'instance' | 'device' }) => storage.delete(k, opts) } };

    // Valid prefs should pass
    const validPrefs: GraphPrefs = { mode: 'auto', refs: ['ref1'] };
    await expect(writeGraphPrefs(host, '/repo/path', validPrefs, false)).resolves.toBeUndefined();

    // The schema enforces mode values and ref array type via Zod strict parsing during read
    const hash = fnv1aHash('/repo/path');
    await storage.set(`status:${hash}`, { mode: 'invalid' }, { scope: 'instance' });
    storage.clearOperations();

    try {
      await readGraphPrefs(host, '/repo/path', false);
      throw new Error('Should have thrown on invalid mode');
    } catch (error) {
      expect(error instanceof Error && error.message).toMatch(/invalid|parse|enum/i);
    }
  });

  test('maintains legacy instance key format for backward compatibility', async () => {
    const storage = new FakeStorageDouble();
    const host: FakeHost = { storage: { get: (k: string, opts?: { scope?: 'instance' | 'device' }) => storage.get(k, opts), set: (k: string, v: JsonValue, opts?: { scope?: 'instance' | 'device' }) => storage.set(k, v, opts), delete: (k: string, opts?: { scope?: 'instance' | 'device' }) => storage.delete(k, opts) } };
    const hash = fnv1aHash('/repo/path');
    const expectedKey = `status:${hash}`;

    await writeGraphPrefs(host, '/repo/path', { mode: 'auto', refs: [] }, false);

    const setOp = storage.getOperations().find((op) => op.op === 'set');
    expect(setOp?.key).toBe(expectedKey);
  });

  test('uses prefs: prefix for device scope key', async () => {
    const storage = new FakeStorageDouble();
    const host: FakeHost = { storage: { get: (k: string, opts?: { scope?: 'instance' | 'device' }) => storage.get(k, opts), set: (k: string, v: JsonValue, opts?: { scope?: 'instance' | 'device' }) => storage.set(k, v, opts), delete: (k: string, opts?: { scope?: 'instance' | 'device' }) => storage.delete(k, opts) } };
    const hash = fnv1aHash('/repo/path');
    const expectedKey = `prefs:${hash}`;

    await writeGraphPrefs(host, '/repo/path', { mode: 'auto', refs: [] }, true);

    const setOp = storage.getOperations().find((op) => op.op === 'set');
    expect(setOp?.key).toBe(expectedKey);
  });

  test('handles empty refs array', async () => {
    const storage = new FakeStorageDouble();
    const host: FakeHost = { storage: { get: (k: string, opts?: { scope?: 'instance' | 'device' }) => storage.get(k, opts), set: (k: string, v: JsonValue, opts?: { scope?: 'instance' | 'device' }) => storage.set(k, v, opts), delete: (k: string, opts?: { scope?: 'instance' | 'device' }) => storage.delete(k, opts) } };

    const result = await readGraphPrefs(host, '/repo/path', false);
    expect(result.prefs.refs).toEqual([]);

    storage.clearOperations();
    await writeGraphPrefs(host, '/repo/path', { mode: 'auto', refs: [] }, false);
    const setOp = storage.getOperations().find((op) => op.op === 'set');
    expect(setOp?.value).toEqual({ mode: 'auto', refs: [] });
  });

  test('handles 32 refs exactly at cap', async () => {
    const storage = new FakeStorageDouble();
    const host: FakeHost = { storage: { get: (k: string, opts?: { scope?: 'instance' | 'device' }) => storage.get(k, opts), set: (k: string, v: JsonValue, opts?: { scope?: 'instance' | 'device' }) => storage.set(k, v, opts), delete: (k: string, opts?: { scope?: 'instance' | 'device' }) => storage.delete(k, opts) } };
    const refs = Array.from({ length: 32 }, (_, i) => `ref${i}`);
    const prefs: GraphPrefs = { mode: 'manual', refs };

    await writeGraphPrefs(host, '/repo/path', prefs, false);

    const setOp = storage.getOperations()[0];
    expect((setOp?.value as GraphPrefs).refs).toHaveLength(32);
  });
});
