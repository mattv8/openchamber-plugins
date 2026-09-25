import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { chromium, type Page } from 'playwright';
import { GitGraphRequestSchema, GitGraphResponseSchema } from '../../plugins/git-graph/src/shared/protocol.js';
import { GuestCatalogSchema, PortAddressSchema, ServiceEnvelopeSchema, SessionIdentitySchema, type InstalledGuest } from '../../plugins/git-graph/tests/integration/host-fixture-contracts.js';
import { createGitFixture, removeFixture } from './fixtures.js';
import { electronExecutableCandidates, hasTrustedHostRemote, hostEnvironment, isCleanGitStatus, isolatedEnvironment, parseHostLock, requireEnvironment, uploadHeaders, type HostLock, type HostTarget } from './contracts.js';

const repositoryRoot = resolve(import.meta.dir, '../..');
const lockPath = join(repositoryRoot, 'testing/hosts.lock.json');

function run(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolvePromise(stdout.trim()) : reject(new Error(`${command} ${args.join(' ')} failed: ${stderr.trim()}`)));
  });
}

async function readLock(): Promise<HostLock> {
  return parseHostLock(JSON.parse(await readFile(lockPath, 'utf8')));
}

async function optionalRun(command: string, args: string[], cwd: string): Promise<string | null> {
  try {
    return await run(command, args, cwd);
  } catch {
    return null;
  }
}

async function assertHostIdentity(source: string, lock: HostLock): Promise<void> {
  const head = await run('git', ['rev-parse', 'HEAD'], source);
  const remotes = {
    origin: await optionalRun('git', ['remote', 'get-url', 'origin'], source),
    upstream: await optionalRun('git', ['remote', 'get-url', 'upstream'], source),
  };
  if (!hasTrustedHostRemote(remotes, lock.stock.repository)) throw new Error(`Host must use ${lock.stock.repository} as origin or upstream; got origin=${remotes.origin ?? '<none>'}, upstream=${remotes.upstream ?? '<none>'}.`);
  if (head !== lock.stock.revision) throw new Error(`Stock host must be ${lock.stock.revision}; got ${head}.`);
  if (!isCleanGitStatus(await run('git', ['status', '--porcelain', '--untracked-files=all'], source))) throw new Error('Stock host must be clean; local changes are not isolation evidence.');
}

async function availablePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = PortAddressSchema.safeParse(server.address());
      server.close((error) => {
        if (error) reject(error);
        else if (!address.success) reject(new Error('Unable to allocate loopback port.'));
        else resolvePromise(address.data.port);
      });
    });
  });
}

async function waitForServer(url: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Host exited before becoming ready (${child.exitCode}).`);
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {
      // The host owns startup; retry its documented loopback endpoint.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error('Host did not become ready within 30 seconds.');
}

function stop(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolvePromise) => {
    child.once('exit', () => resolvePromise());
    child.kill('SIGTERM');
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 2_000).unref();
  });
}

async function installPackedPlugin(url: string, archive: string): Promise<void> {
  if (!archive.endsWith('.zip')) throw new Error('OPENCHAMBER_PLUGIN_ZIP must point to a packed .zip, never a source tree.');
  await access(archive);
  const payload = await Bun.file(archive).arrayBuffer();
  const response = await fetch(`${url}/api/guests/upload`, { method: 'POST', headers: uploadHeaders(payload.byteLength), body: payload });
  if (!response.ok) throw new Error(`Packed plugin install failed: ${response.status} ${await response.text()}`);
}

async function approveInstalledPlugin(url: string, guest: InstalledGuest): Promise<void> {
  const requested = guest.capabilities?.requested;
  if (!requested || requested.length !== 1 || requested[0] !== 'service') throw new Error('Installed Git Graph plugin must request only the service capability.');
  const response = await fetch(`${url}/api/guests/git-graph/capabilities`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ granted: requested }),
  });
  if (!response.ok) throw new Error(`Git Graph capability approval failed: ${response.status} ${await response.text()}`);
}

type SessionIdentity = { id: string; title: string };

async function createFixtureSession(url: string, fixture: string): Promise<SessionIdentity> {
  const response = await fetch(`${url}/api/session?directory=${encodeURIComponent(fixture)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Git Graph verification', location: { directory: fixture } }),
  });
  if (!response.ok) throw new Error(`Fixture session creation failed: ${response.status} ${await response.text()}`);
  const payload = SessionIdentitySchema.safeParse(await response.json());
  if (!payload.success) {
    throw new Error('Fixture session creation returned no session id.');
  }
  return { id: payload.data.id, title: 'Git Graph verification' };
}

async function checkActualBehavior(name: string, failures: string[], action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function verifyStatusSection(page: Page, evidenceRoot: string): Promise<string[]> {
  const failures: string[] = [];
  await checkActualBehavior('work-status mounts the Git Graph section and folds its status frame', failures, async () => {
    const workStatusToggle = page.getByRole('button', { name: 'Toggle work-status panel' });
    if (await workStatusToggle.getAttribute('aria-pressed') !== 'true') await workStatusToggle.click({ timeout: 30_000 });
    const toggle = page.getByRole('complementary', { name: 'Work status' }).getByRole('button', { name: 'Git', exact: true });
    const section = toggle.locator('xpath=ancestor::section');
    await section.waitFor({ state: 'visible', timeout: 15_000 });
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    const frame = section.frameLocator('iframe');
    await frame.locator('[data-git-graph-status="true"]').waitFor({ state: 'visible', timeout: 15_000 });
    for (const mode of ['Auto', 'All', 'Manual']) await frame.getByRole('tab', { name: mode, exact: true }).click();
    await frame.locator('[data-git-graph-status="true"] input[type="checkbox"]').first().waitFor({ state: 'visible', timeout: 15_000 });
    await frame.getByRole('tab', { name: 'Auto', exact: true }).click();
    await frame.getByText('Second fixture commit', { exact: true }).click();
    // Native commit navigation closes Work Status; reopen it before testing collapse.
    await page.locator('[data-context-panel="true"]').waitFor({ state: 'visible', timeout: 15_000 });
    if (await workStatusToggle.getAttribute('aria-pressed') !== 'true') await workStatusToggle.click();
    await toggle.waitFor({ state: 'visible', timeout: 15_000 });
    await toggle.click();
    await section.locator('iframe').waitFor({ state: 'detached', timeout: 15_000 });
    if (await workStatusToggle.getAttribute('aria-pressed') === 'true') await workStatusToggle.click({ timeout: 15_000 });
  });

  await mkdir(evidenceRoot, { recursive: true });
  await page.screenshot({ path: join(evidenceRoot, 'v2-status-section.png'), fullPage: true });

  return failures;
}

async function registerFixtureProject(dataDirectory: string, fixture: string): Promise<void> {
  await writeFile(join(dataDirectory, 'settings.json'), JSON.stringify({
    projects: [{ id: 'git-graph-fixture', path: fixture, addedAt: Date.now(), lastOpenedAt: Date.now() }],
    activeProjectId: 'git-graph-fixture',
    lastDirectory: fixture,
  }, null, 2));
}

export async function runIsolatedHost(target: HostTarget): Promise<void> {
  const source = requireEnvironment('OPENCHAMBER_HOST_SOURCE');
  if (target === 'electron') {
    const candidates = electronExecutableCandidates(source);
    let executable: string | null = null;
    for (const candidate of candidates) {
      try {
        await access(candidate);
        executable = candidate;
        break;
      } catch {
        // Try the next platform-specific candidate.
      }
    }
    if (!executable) {
      throw new Error(`test:app:electron is UNAVAILABLE: no unpackaged Electron binary exists in ${source}. Checked ${candidates.join(', ')}. Run the host's Electron install step before native-shell verification.`);
    }
    throw new Error(`test:app:electron is BLOCKED: found ${executable}, but this checkout has no reviewed native-shell inspection runner. Web coverage is not reported as Electron coverage.`);
  }
  const archive = requireEnvironment('OPENCHAMBER_PLUGIN_ZIP');
  const opencode = requireEnvironment('OPENCHAMBER_TEST_OPENCODE_BINARY');
  const lock = await readLock();
  await assertHostIdentity(source, lock);
  await stat(join(source, 'packages/web/server/index.js'));
  try {
    await stat(join(source, 'packages/web/dist/index.html'));
  } catch {
    throw new Error(`Host UI assets are absent at ${join(source, 'packages/web/dist/index.html')}. Run the host's documented build before starting an actual browser test.`);
  }
  const runRoot = await Bun.$`mktemp -d ${join(repositoryRoot, '.cache/git-graph-host-XXXXXX')}`.text();
  const root = runRoot.trim();
  const environment = isolatedEnvironment(root, opencode);
  const port = await availablePort();
  const url = `http://127.0.0.1:${port}`;
  let host: ChildProcess | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const isolatedPaths = Object.values(hostEnvironment(root)).filter((path): path is string => path !== undefined);
    await Promise.all(isolatedPaths.map((path) => mkdir(path.endsWith('.json') ? resolve(path, '..') : path, { recursive: true })));
    const fixture = await createGitFixture(join(root, 'fixture'));
    await registerFixtureProject(environment.OPENCHAMBER_DATA_DIR!, fixture);
    host = spawn(process.execPath, ['packages/web/server/index.js', '--host', '127.0.0.1', '--port', String(port)], { cwd: source, env: environment, stdio: 'pipe', detached: process.platform !== 'win32' });
    await waitForServer(url, host);
    await installPackedPlugin(url, archive);
    const guests = GuestCatalogSchema.parse(await fetch(`${url}/api/guests`).then(async (response) => response.ok ? response.json() : Promise.reject(new Error(`Guest catalog failed: ${response.status}`))));
    const installed = guests.guests.find((guest) => guest.id === 'git-graph');
    if (!installed) throw new Error('Packed Git Graph plugin did not appear in the real host catalog.');
    if (!installed.statusEntry || installed.entry || installed.pageEntry) throw new Error('Git Graph must contribute only a status section.');
    await approveInstalledPlugin(url, installed);
    const fixtureSession = await createFixtureSession(url, fixture);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const consoleMessages: string[] = [];
    const serviceEvidence: string[] = [];
    page.on('console', (message) => consoleMessages.push(`${message.type()}: ${message.text()}`));
    page.on('request', (request) => {
      if (!request.url().includes('/api/guests/git-graph/service/request')) return;
      try {
        const envelope = ServiceEnvelopeSchema.parse(JSON.parse(request.postData() ?? 'null'));
        const body = GitGraphRequestSchema.parse(JSON.parse(envelope.body));
        serviceEvidence.push(body.operation === 'repo/open'
          ? `repo/open directory=${body.directory === fixture ? 'fixture' : 'other'}`
          : body.operation);
      } catch {
        serviceEvidence.push('unparsed service request');
      }
    });
    page.on('response', (response) => {
      if (!response.url().includes('/api/guests/git-graph/service/request')) return;
      void response.json().then((payload) => {
        const envelope = ServiceEnvelopeSchema.parse(payload);
        const body = GitGraphResponseSchema.parse(JSON.parse(envelope.body));
        const outcome = body.ok ? 'ok' : body.error.code;
        serviceEvidence.push(`${body.operation} response=${outcome}`);
      }).catch(() => serviceEvidence.push(`http response=${response.status()}`));
    });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    if (fixtureSession) await page.getByText(fixtureSession.title, { exact: true }).first().click({ timeout: 30_000 });
    const evidenceRoot = join(repositoryRoot, '.cache/evidence');
    const actualBehaviorFailures: string[] = [];
    actualBehaviorFailures.push(...await verifyStatusSection(page, evidenceRoot));
    await writeFile(join(evidenceRoot, `${target}-git-graph-console.txt`), `${consoleMessages.join('\n')}\n`);
    await writeFile(join(evidenceRoot, `${target}-git-graph-service.txt`), `${serviceEvidence.join('\n')}\n`);
    if (actualBehaviorFailures.length > 0) {
      throw new Error(`${target} actual-app checks failed:\n- ${actualBehaviorFailures.join('\n- ')}`);
    }
    console.log(`PASS ${target}: installed packed Git Graph into an isolated real host with fixture ${basename(fixture)}.`);
  } finally {
    await browser?.close();
    await stop(host);
    await removeFixture(join(root, 'fixture'));
    await rm(root, { recursive: true, force: true });
  }
}
