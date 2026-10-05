import type { HostClient } from '@openchamber/sdk';
import { z } from 'zod';
import type { HistoryMode } from '../domain/index.js';

export type GraphPrefs = { mode: HistoryMode; refs: string[] };
export type GraphPrefsRead = { prefs: GraphPrefs; source: 'device' | 'legacy' | 'default' };

const PreferencesSchema = z.object({ mode: z.enum(['auto', 'all', 'manual']), refs: z.array(z.string()).max(32) }).strict();
const defaultPreferences: GraphPrefs = { mode: 'auto', refs: [] };

/** FNV-1a hash matching StatusSection.preferenceKey */
function hashDirectory(directory: string): string {
  let hash = 2166136261;
  for (let index = 0; index < directory.length; index += 1) {
    hash = Math.imul(hash ^ directory.charCodeAt(index), 16777619);
  }
  return (hash >>> 0).toString(36);
}

/** Throws on storage failure or an invalid stored value; never substitutes defaults for a failed read. */
export async function readGraphPrefs(host: { storage: Pick<HostClient['storage'], 'get' | 'set'> }, directory: string, deviceStorage: boolean): Promise<GraphPrefsRead> {
  const hash = hashDirectory(directory);
  const deviceKey = `prefs:${hash}`;
  const legacyKey = `status:${hash}`;

  if (deviceStorage) {
    // Try device scope first
    const deviceValue = await host.storage.get(deviceKey, { scope: 'device' });
    if (deviceValue !== undefined) {
      const parsed = PreferencesSchema.safeParse(deviceValue);
      if (!parsed.success) throw new Error(`Invalid preferences in device storage: ${parsed.error.message}`);
      return { prefs: parsed.data, source: 'device' };
    }

    // Fall back to legacy instance scope
    const legacyValue = await host.storage.get(legacyKey, { scope: 'instance' });
    if (legacyValue !== undefined) {
      const parsed = PreferencesSchema.safeParse(legacyValue);
      if (!parsed.success) throw new Error(`Invalid preferences in legacy storage: ${parsed.error.message}`);

      // Best-effort copy to device (failure does not fail the read)
      void host.storage.set(deviceKey, parsed.data, { scope: 'device' }).catch(() => undefined);

      return { prefs: parsed.data, source: 'legacy' };
    }

    // Both absent, return default
    return { prefs: { ...defaultPreferences, refs: [] }, source: 'default' };
  }

  // deviceStorage=false: legacy instance key only
  const legacyValue = await host.storage.get(legacyKey, { scope: 'instance' });
  if (legacyValue !== undefined) {
    const parsed = PreferencesSchema.safeParse(legacyValue);
    if (!parsed.success) throw new Error(`Invalid preferences in legacy storage: ${parsed.error.message}`);
    return { prefs: parsed.data, source: 'legacy' };
  }

  return { prefs: { ...defaultPreferences, refs: [] }, source: 'default' };
}

/** Rejects when the write fails. */
export async function writeGraphPrefs(host: { storage: Pick<HostClient['storage'], 'get' | 'set'> }, directory: string, prefs: GraphPrefs, deviceStorage: boolean): Promise<void> {
  const hash = hashDirectory(directory);
  const key = deviceStorage ? `prefs:${hash}` : `status:${hash}`;
  const scope = deviceStorage ? 'device' : 'instance';

  // Cap refs at 32 and write
  const capped: GraphPrefs = { ...prefs, refs: prefs.refs.slice(0, 32) };
  await host.storage.set(key, capped, { scope });
}
