import { describe, expect, test } from 'bun:test';
import { electronExecutableCandidates, hasTrustedHostRemote, hostEnvironment, isCleanGitStatus, isolatedEnvironment, parseHostLock, uploadHeaders } from './contracts.js';

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
  });

  test('does not leak inherited provider credentials into the host', () => {
    const environment = isolatedEnvironment('/tmp/git-graph-run', '/opt/homebrew/bin/opencode', { PATH: '/usr/bin', OPENAI_API_KEY: 'secret', LANG: 'en_US.UTF-8' });
    expect(environment.OPENCODE_BINARY).toBe('/opt/homebrew/bin/opencode');
    expect(environment.PATH).toBe('/usr/bin');
    expect(environment.OPENAI_API_KEY).toBeUndefined();
    expect(environment.LANG).toBe('en_US.UTF-8');
  });

  test('resolves the unpackaged Electron binary inside the selected host', () => {
    expect(electronExecutableCandidates('/host', 'darwin')).toEqual(['/host/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron']);
    expect(electronExecutableCandidates('/host', 'linux')).toEqual(['/host/node_modules/electron/dist/electron']);
    expect(electronExecutableCandidates('/host', 'win32')).toEqual(['/host/node_modules/electron/dist/electron.exe']);
  });

  test('uploads packed extensions as the server raw-archive contract requires', () => {
    expect(uploadHeaders(42)).toEqual({ 'content-type': 'application/octet-stream', 'content-length': '42' });
  });
});
