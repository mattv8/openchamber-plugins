import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { electronExecutableCandidates, hasTrustedHostRemote, hostEnvironment, isCleanGitStatus, isolatedEnvironment, parseHostLock, uploadHeaders } from './contracts.js';
import { assertNativeProcessesStopped, authenticatedHeaders, electronLaunchEnvironment, requireElectronAssets, runtimeConnection } from './electron.js';

describe('isolated host contracts', () => {
  test('rejects a stock lock whose revision is not a full commit identity', () => {
    expect(() => parseHostLock({ stock: { repository: 'openchamber/openchamber', version: '2.0.1', revision: 'short' } })).toThrow('stock.revision');
  });

  test('accepts the official remote through upstream when origin is a fork at the trusted revision', () => {
    expect(hasTrustedHostRemote({ origin: 'git@github.com:elfy/openchamber.git', upstream: 'https://github.com/openchamber/openchamber.git' }, 'openchamber/openchamber')).toBe(true);
  });

  test('rejects a fork without an official upstream remote', () => {
    expect(hasTrustedHostRemote({ origin: 'git@github.com:elfy/openchamber.git', upstream: null }, 'openchamber/openchamber')).toBe(false);
  });

  test('requires the trusted host checkout to be clean', () => {
    expect(isCleanGitStatus('')).toBe(true);
    expect(isCleanGitStatus(' M packages/ui/src/App.tsx')).toBe(false);
  });

  test('uses only directories inside the run root for host state', () => {
    const environment = hostEnvironment('/tmp/git-graph-run');
    expect(environment.HOME).toBe('/tmp/git-graph-run/home');
    expect(environment.OPENCHAMBER_DATA_DIR).toBe('/tmp/git-graph-run/openchamber-data');
    expect(environment.OPENCODE_CONFIG).toBe('/tmp/git-graph-run/opencode-config/opencode.json');
    expect(environment.OPENCHAMBER_DESKTOP_USER_DATA_DIR).toBe('/tmp/git-graph-run/electron-user-data');
    expect(environment.OPENCHAMBER_MANAGED_PROCESS_REGISTRY).toBe('/tmp/git-graph-run/managed-opencode');
  });

  test('does not leak inherited provider credentials into the host', () => {
    const environment = isolatedEnvironment('/tmp/git-graph-run', '/opt/homebrew/bin/opencode', { PATH: '/usr/bin', OPENAI_API_KEY: 'secret', LANG: 'en_US.UTF-8' });
    expect(environment.OPENCODE_BINARY).toBe('/opt/homebrew/bin/opencode');
    expect(environment.PATH).toBe('/usr/bin');
    expect(environment.OPENAI_API_KEY).toBeUndefined();
    expect(environment.LANG).toBe('en_US.UTF-8');
  });

  test('resolves the unpackaged Electron binary inside the selected host', () => {
    expect(electronExecutableCandidates('/host', 'darwin')).toEqual([
      '/host/packages/electron/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
      '/host/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
    ]);
    expect(electronExecutableCandidates('/host', 'linux')).toEqual(['/host/packages/electron/node_modules/electron/dist/electron', '/host/node_modules/electron/dist/electron']);
    expect(electronExecutableCandidates('/host', 'win32')).toEqual(['/host/packages/electron/node_modules/electron/dist/electron.exe', '/host/node_modules/electron/dist/electron.exe']);
  });

  test('requires a built Electron entry and bundled UI before native launch', async () => {
    await expect(requireElectronAssets('/missing-host')).rejects.toThrow('UNAVAILABLE');
  });

  test('adds only native launch flags to the isolated environment', () => {
    const environment = electronLaunchEnvironment('/tmp/git-graph-run', '/opt/homebrew/bin/opencode', { PATH: '/usr/bin', OPENAI_API_KEY: 'secret' });
    expect(environment.OPENCHAMBER_ELECTRON_DEV).toBe('1');
    expect(environment.OPENCHAMBER_ELECTRON_USE_BUNDLED_UI).toBe('1');
    expect(environment.OPENAI_API_KEY).toBeUndefined();
    expect(environment.OPENCHAMBER_DESKTOP_USER_DATA_DIR).toBe('/tmp/git-graph-run/electron-user-data');
  });

  test('accepts only loopback HTTP connections and supports a fresh local desktop without a password', () => {
    expect(runtimeConnection({ apiBaseUrl: 'http://127.0.0.1:57123', clientToken: 'test-token' })).toEqual({ apiBaseUrl: 'http://127.0.0.1:57123', clientToken: 'test-token' });
    expect(() => runtimeConnection({ apiBaseUrl: 'https://remote.example', clientToken: 'test-token' })).toThrow('loopback');
    expect(authenticatedHeaders(runtimeConnection({ apiBaseUrl: 'http://127.0.0.1:57123', clientToken: '' }))).toEqual({});
    expect(authenticatedHeaders(runtimeConnection({ apiBaseUrl: 'http://127.0.0.1:57123', clientToken: 'test-token' }))).toEqual({ authorization: 'Bearer test-token' });
    expect(() => runtimeConnection({ apiBaseUrl: 'ftp://127.0.0.1/etc', clientToken: 'test-token' })).toThrow();
    expect(() => runtimeConnection({ apiBaseUrl: 'http://user:password@localhost:57123', clientToken: 'test-token' })).toThrow();
    expect(runtimeConnection({ apiBaseUrl: 'http://[::1]:57123', clientToken: 'test-token' }).apiBaseUrl).toBe('http://[::1]:57123');
  });

  test('uploads packed extensions as the server raw-archive contract requires', () => {
    expect(uploadHeaders(42)).toEqual({ 'content-type': 'application/octet-stream', 'content-length': '42' });
  });

  test('pre-entry isolation blocks OS registrations without replacing inspection APIs', async () => {
    let writes = 0;
    const app = {
      setAsDefaultProtocolClient: () => { writes += 1; return true; },
      removeAsDefaultProtocolClient: () => { writes += 1; return true; },
      setLoginItemSettings: () => { writes += 1; },
      isDefaultProtocolClient: () => false,
    };
    runInNewContext(await readFile(new URL('./electron-isolation.cjs', import.meta.url), 'utf8'), {
      require: (name: string) => { if (name !== 'electron') throw new Error(name); return { app }; },
    });
    expect(app.setAsDefaultProtocolClient()).toBe(false);
    expect(app.removeAsDefaultProtocolClient()).toBe(false);
    app.setLoginItemSettings();
    expect(writes).toBe(0);
    expect(app.isDefaultProtocolClient()).toBe(false);
  });

  test('cleanup cannot report success while a recorded process remains alive', () => {
    expect(() => assertNativeProcessesStopped([process.pid])).toThrow('still alive');
    expect(() => assertNativeProcessesStopped([])).not.toThrow();
  });
});
