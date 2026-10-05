import { access, readdir, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Page } from 'playwright';
import { isolatedEnvironment } from './contracts.js';

export type RuntimeConnection = { apiBaseUrl: string; clientToken: string };

export function electronLaunchEnvironment(runRoot: string, opencodeBinary: string, inherited?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const display = inherited ?? process.env;
  return {
    ...isolatedEnvironment(runRoot, opencodeBinary, inherited),
    ...(display.DISPLAY ? { DISPLAY: display.DISPLAY } : {}),
    ...(display.XAUTHORITY ? { XAUTHORITY: display.XAUTHORITY } : {}),
    OPENCHAMBER_ELECTRON_DEV: '1',
    OPENCHAMBER_ELECTRON_USE_BUNDLED_UI: '1',
  };
}

export async function requireElectronAssets(source: string): Promise<{ entry: string }> {
  // Match electron:dev:bundled: the source entry resolves resources and preload
  // beside itself. dist-bundle is a packaging input, not a dev launch directory.
  const entry = resolve(source, 'packages/electron/entry.mjs');
  const preload = resolve(source, 'packages/electron/preload.mjs');
  const bundledUi = resolve(source, 'packages/electron/resources/web-dist/index.html');
  for (const asset of [entry, preload, bundledUi]) {
    try {
      await access(asset);
    } catch {
      throw new Error(`test:app:electron is UNAVAILABLE: required native asset is absent at ${asset}. Run node packages/electron/scripts/build-web-assets.mjs in the locked host checkout before native-shell verification.`);
    }
  }
  return { entry };
}

/** executablePath skips Playwright's dev loader; explicitly use its own loader
 * so app startup waits for inspection rather than racing the main context. */
export async function electronDevArguments(entry: string): Promise<string[]> {
  const fromPlaywright = createRequire(import.meta.resolve('playwright'));
  const loader = join(dirname(fromPlaywright.resolve('playwright-core')), 'lib/server/electron/loader.js');
  await access(loader);
  const isolation = fileURLToPath(new URL('./electron-isolation.cjs', import.meta.url));
  await access(isolation);
  return ['-r', loader, '-r', isolation, entry];
}

export function runtimeConnection(value: RuntimeConnection): RuntimeConnection {
  const apiBaseUrl = value.apiBaseUrl.trim();
  const clientToken = value.clientToken.trim();
  let url: URL;
  try {
    url = new URL(apiBaseUrl);
  } catch {
    throw new Error('Native runtime did not expose a valid API URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Native runtime API URL must use HTTP.');
  if (url.username || url.password) throw new Error('Native runtime API URL must not contain credentials.');
  if (!['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) throw new Error('Native runtime API URL must be loopback.');
  // A fresh loopback-only desktop without a UI password has no client token.
  return { apiBaseUrl: url.origin, clientToken };
}

export async function discoverRuntimeConnection(page: Page): Promise<RuntimeConnection> {
  await page.waitForFunction(() => {
    const runtime = window as typeof window & { __OPENCHAMBER_API_BASE_URL__?: string; __OPENCHAMBER_CLIENT_TOKEN__?: string };
    return Boolean(runtime.__OPENCHAMBER_API_BASE_URL__);
  }, undefined, { timeout: 30_000 });
  return runtimeConnection(await page.evaluate(() => {
    const runtime = window as typeof window & { __OPENCHAMBER_API_BASE_URL__?: string; __OPENCHAMBER_CLIENT_TOKEN__?: string };
    return {
      apiBaseUrl: String(runtime.__OPENCHAMBER_API_BASE_URL__ || ''),
      clientToken: String(runtime.__OPENCHAMBER_CLIENT_TOKEN__ || ''),
    };
  }));
}

export function authenticatedHeaders(connection: RuntimeConnection, headers: Record<string, string> = {}): Record<string, string> {
  return connection.clientToken ? { ...headers, authorization: `Bearer ${connection.clientToken}` } : headers;
}

export function nativeEvidenceRoot(repositoryRoot: string): string {
  return join(repositoryRoot, '.cache/evidence/electron');
}

export async function nativeProcessIds(runRoot: string): Promise<number[]> {
  const directory = resolve(runRoot, 'managed-opencode');
  let files: string[];
  try { files = await readdir(directory); } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  const ids: number[] = [];
  for (const file of files.filter((name) => /^\d+\.json$/.test(name))) {
    try {
      const entry: unknown = JSON.parse(await readFile(join(directory, file), 'utf8'));
      if (!entry || typeof entry !== 'object' || !('pid' in entry) || typeof entry.pid !== 'number' || !Number.isSafeInteger(entry.pid) || entry.pid <= 0) {
        throw new Error(`Invalid test process registry entry: ${file}`);
      }
      ids.push(entry.pid);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  return ids;
}

export function assertNativeProcessesStopped(pids: readonly number[]): void {
  for (const pid of pids) {
    try { process.kill(pid, 0); } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') continue;
      throw error;
    }
    throw new Error(`Test-owned OpenCode process ${pid} is still alive; preserving the isolated run directory.`);
  }
}

/** A crashed desktop can leave its detached OpenCode server alive. Reuse the
 * pinned host's identity-checking reaper, restricted to this test's registry. */
export async function reapNativeProcesses(source: string, runRoot: string, opencodeBinary: string, observedPids: readonly number[] = []): Promise<void> {
  const pids = new Set([...observedPids, ...await nativeProcessIds(runRoot)]);
  const registryModule = pathToFileURL(resolve(source, 'packages/web/server/lib/opencode/managed-process-registry.js')).href;
  await promisify(execFile)(process.execPath, ['-e', `await (await import(${JSON.stringify(registryModule)})).reapOrphanedProcesses()`], {
    env: isolatedEnvironment(runRoot, opencodeBinary),
    timeout: 15_000,
  });
  assertNativeProcessesStopped([...pids]);
}
