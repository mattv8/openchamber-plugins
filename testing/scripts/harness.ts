import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { _electron, chromium, type ElectronApplication, type Page } from 'playwright';
import { GitGraphRequestSchema, GitGraphResponseSchema } from '../../plugins/git-graph/src/shared/protocol.js';
import { GuestCatalogSchema, PortAddressSchema, ServiceEnvelopeSchema, SessionIdentitySchema, type InstalledGuest } from '../../plugins/git-graph/tests/integration/host-fixture-contracts.js';
import { createGitFixture, removeFixture } from './fixtures.js';
import { electronExecutableCandidates, hasTrustedHostRemote, hostEnvironment, isCleanGitStatus, isolatedEnvironment, parseHostLock, requireEnvironment, uploadHeaders, type HostLock, type HostTarget } from './contracts.js';
import { authenticatedHeaders, discoverRuntimeConnection, electronDevArguments, electronLaunchEnvironment, nativeEvidenceRoot, nativeProcessIds, reapNativeProcesses, requireElectronAssets } from './electron.js';

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

async function installPackedPlugin(url: string, archive: string, headers: Record<string, string> = {}): Promise<void> {
  if (!archive.endsWith('.zip')) throw new Error('OPENCHAMBER_PLUGIN_ZIP must point to a packed .zip, never a source tree.');
  await access(archive);
  const payload = await Bun.file(archive).arrayBuffer();
  const response = await fetch(`${url}/api/guests/upload`, { method: 'POST', headers: { ...uploadHeaders(payload.byteLength), ...headers }, body: payload });
  if (!response.ok) throw new Error(`Packed plugin install failed: ${response.status} ${await response.text()}`);
}

async function approveInstalledPlugin(url: string, guest: InstalledGuest, headers: Record<string, string> = {}): Promise<void> {
  const requested = guest.capabilities?.requested;
  if (!requested || requested.length !== 2 || !requested.includes('service') || !requested.includes('origins')) throw new Error('Installed Git Graph plugin must request service and avatar-origin capabilities.');
  const response = await fetch(`${url}/api/guests/git-graph/capabilities`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ granted: requested }),
  });
  if (!response.ok) throw new Error(`Git Graph capability approval failed: ${response.status} ${await response.text()}`);
}

type SessionIdentity = { id: string; title: string };

async function createFixtureSession(url: string, fixture: string, headers: Record<string, string> = {}): Promise<SessionIdentity> {
  const response = await fetch(`${url}/api/session?directory=${encodeURIComponent(fixture)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
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

function redactRuntimeSecrets(message: string): string {
  return message.replace(/(["']?authorization["']?\s*[:=]\s*["']?bearer\s+|["']?clientToken["']?\s*[:=]\s*["']?|--openchamber-client-token=)[^\s"']+/gi, '$1[redacted]');
}

async function verifyStatusSection(page: Page, evidenceRoot: string, fixture: string): Promise<string[]> {
  const failures: string[] = [];
  await mkdir(evidenceRoot, { recursive: true });
  const workStatusToggle = page.getByRole('button', { name: 'Toggle work-status panel' });
  const workStatus = page.getByRole('complementary', { name: 'Work status' });
  const toggle = workStatus.getByRole('button', { name: 'Git', exact: true });
  const section = toggle.locator('xpath=ancestor::section');
  const frame = section.frameLocator('iframe');
  const popover = page.locator('[data-guest-popover-overlay] iframe').contentFrame();
  const openSection = async () => {
    if (await workStatusToggle.getAttribute('aria-pressed') !== 'true') await workStatusToggle.click({ timeout: 30_000 });
    await section.waitFor({ state: 'visible', timeout: 15_000 });
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    await frame.getByRole('button', { name: /Second fixture commit/ }).waitFor({ state: 'visible', timeout: 20_000 });
  };

  await checkActualBehavior('the Git section starts collapsed and expands to the graph', failures, async () => {
    if (await workStatusToggle.getAttribute('aria-pressed') !== 'true') await workStatusToggle.click({ timeout: 30_000 });
    await section.waitFor({ state: 'visible', timeout: 15_000 });
    if (await toggle.getAttribute('aria-expanded') !== 'false') throw new Error('fresh Git section was not collapsed by default');
    await openSection();
  });

  await checkActualBehavior('host header Range control switches history and Refresh reloads it', failures, async () => {
    await openSection();
    if (await frame.getByRole('tab', { name: 'Auto', exact: true }).count() !== 0) throw new Error('body controls rendered although the host supports header controls');
    const range = section.getByRole('button', { name: /^Range/ });
    await range.click();
    await page.getByRole('menuitemradio', { name: 'All', exact: true }).click();
    // Host radio menus stay open after a choice; dismiss before reopening.
    await page.keyboard.press('Escape');
    await section.getByRole('button', { name: /^Range: All/ }).waitFor({ timeout: 10_000 });
    // Each load toggles the host-rendered Refresh control; reopen the menu once the reload settles.
    await section.getByRole('button', { name: 'Refresh', exact: true }).and(page.locator(':enabled')).waitFor({ timeout: 15_000 });
    await frame.locator('[aria-busy="true"]').waitFor({ state: 'detached', timeout: 15_000 });
    await section.getByRole('button', { name: /^Range/ }).click();
    await page.getByRole('menuitemradio', { name: 'Auto', exact: true }).click();
    await page.keyboard.press('Escape');
    await section.getByRole('button', { name: 'Refresh', exact: true }).click();
    await frame.getByRole('button', { name: /Second fixture commit/ }).waitFor({ state: 'visible', timeout: 15_000 });
    // Refresh disables itself while loading; wait for the reload to finish before the next step.
    await section.getByRole('button', { name: 'Refresh', exact: true }).and(page.locator(':enabled')).waitFor({ timeout: 15_000 });
  });

  await checkActualBehavior('hovering a commit shows its card outside the status frame without taking focus', failures, async () => {
    await openSection();
    // A reload can leave the pointer over another row; let any earlier preview close first.
    await page.mouse.move(10, 10);
    await page.locator('[data-guest-popover-overlay]').waitFor({ state: 'detached', timeout: 10_000 });
    const target = frame.getByRole('button', { name: /Second fixture commit/ });
    const commit = await target.getAttribute('data-git-graph-status-commit');
    // The Work Status panel may still be settling after the reload; hover only once the row stops moving.
    let box = await target.boundingBox();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await page.waitForTimeout(150);
      const next = await target.boundingBox();
      if (box && next && next.x === box.x && next.y === box.y) break;
      box = next;
    }
    if (!box) throw new Error('commit row has no layout box');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
    const card = popover.locator(`[data-git-graph-commit-hover="${commit}"]`);
    await card.waitFor({ state: 'visible', timeout: 20_000 }).catch(async () => {
      const shown = await popover.locator('[data-git-graph-commit-hover]').getAttribute('data-git-graph-commit-hover', { timeout: 500 }).catch(() => 'none');
      const rows = await frame.locator('[data-git-graph-status-commit]').evaluateAll((items) => items.map((row) => [row.getAttribute('data-git-graph-status-commit')?.slice(0, 8), row.getAttribute('data-oc-popover-open'), row.getAttribute('aria-label'), row.matches(':hover'), Math.round(row.getBoundingClientRect().top)]));
      const frameBox = await section.locator('iframe').boundingBox();
      throw new Error(`no card for ${commit}; overlays=${await page.locator('[data-guest-popover-overlay]').count()} shown=${shown} rows=${JSON.stringify(rows)} box=${JSON.stringify(box)} frame=${JSON.stringify(frameBox)} popoverBody=${(await popover.locator('body').innerText({ timeout: 500 }).catch(() => '')).slice(0, 200)}`);
    });
    const cardText = await card.textContent({ timeout: 5_000 }) ?? '';
    await page.screenshot({ path: join(evidenceRoot, 'v2-hover-card.png') });
    for (const text of ['Second fixture commit', 'Git Graph Test', 'git-graph-test@example.invalid']) if (!cardText.includes(text)) throw new Error(`hover card lacks ${text}: ${cardText}`);
    const stillOpen: string[] = [];
    for (let index = 0; index < 4; index += 1) { await page.waitForTimeout(250); stillOpen.push(String(await page.locator('[data-guest-popover-overlay]').count())); }
    if (stillOpen.includes('0')) throw new Error(`hover card closed while the pointer stayed on its row: ${stillOpen.join(',')}`);
    await card.getByText(/1 file changed/).waitFor({ timeout: 10_000 });
    await card.getByRole('button', { name: /GitHub/ }).waitFor({ timeout: 10_000 });
    const overlay = await page.locator('[data-guest-popover-overlay]').boundingBox();
    const owner = await section.locator('iframe').boundingBox();
    if (!overlay || !owner || overlay.x + overlay.width > owner.x + 1) throw new Error('hover card is not placed outside (left of) the status frame');
    if (await page.evaluate(() => Boolean(document.activeElement?.closest('[data-guest-popover-overlay]')))) throw new Error('hover card took keyboard focus');
    await page.screenshot({ path: join(evidenceRoot, 'v2-hover-card.png') });
    await page.mouse.move(10, 10);
    await page.locator('[data-guest-popover-overlay]').waitFor({ state: 'detached', timeout: 10_000 });
  });

  await checkActualBehavior('clicking a commit expands its files and a file opens the native commit diff', failures, async () => {
    await openSection();
    const row = frame.getByRole('button', { name: /Second fixture commit/ });
    await row.click();
    if (await row.getAttribute('aria-expanded') !== 'true') throw new Error('row did not report its expanded file list');
    const file = frame.locator('[data-git-status-file-list] button', { hasText: 'README.md' });
    await file.waitFor({ state: 'visible', timeout: 15_000 });
    await page.screenshot({ path: join(evidenceRoot, 'v2-file-list.png') });
    await file.click();
    await page.locator('[data-context-panel="true"]').waitFor({ state: 'visible', timeout: 15_000 });
  });

  await checkActualBehavior('the context menu creates a tag through the plugin service and the graph shows it', failures, async () => {
    await openSection();
    await frame.getByRole('button', { name: /Initial fixture/ }).click({ button: 'right' });
    await popover.getByRole('menuitem', { name: /Create tag/ }).click({ timeout: 20_000 });
    await popover.getByRole('textbox', { name: 'Tag name' }).fill('graph-test-tag');
    await popover.getByRole('button', { name: 'Create tag', exact: true }).click();
    const view = popover.locator('[data-commit-menu-view]').first();
    await popover.locator('[data-commit-menu-view="confirm"]').waitFor({ timeout: 20_000 }).catch(async () => { throw new Error(`menu showed ${await view.getAttribute('data-commit-menu-view')}: ${await view.innerText()}`); });
    await page.screenshot({ path: join(evidenceRoot, 'v2-menu-confirm.png') });
    await popover.locator('[data-commit-menu-view="confirm"]').getByRole('button', { name: 'Create tag', exact: true }).click();
    await page.locator('[data-guest-popover-overlay]').waitFor({ state: 'detached', timeout: 20_000 });
    const tags = await run('git', ['tag', '--list', 'graph-test-tag'], fixture);
    if (tags !== 'graph-test-tag') throw new Error(`fixture tag was not created (got ${JSON.stringify(tags)})`);
    await frame.locator('[data-git-ref-badge-group="refs/tags/graph-test-tag"], [data-git-ref-badge="refs/tags/graph-test-tag"]').first().waitFor({ state: 'attached', timeout: 15_000 });
  });

  await checkActualBehavior('collapsing the section unmounts its frame', failures, async () => {
    await openSection();
    await toggle.click();
    await section.locator('iframe').waitFor({ state: 'detached', timeout: 15_000 });
  });

  await page.screenshot({ path: join(evidenceRoot, 'v2-status-section.png'), fullPage: true });
  return failures;
}

async function registerFixtureProject(dataDirectory: string, fixture: string, desktop = false): Promise<void> {
  await writeFile(join(dataDirectory, 'settings.json'), JSON.stringify({
    projects: [{ id: 'git-graph-fixture', path: fixture, addedAt: Date.now(), lastOpenedAt: Date.now() }],
    activeProjectId: 'git-graph-fixture',
    lastDirectory: fixture,
    ...(desktop ? { desktopDefaultHostId: 'local', desktopInitialHostChoiceCompleted: true } : {}),
  }, null, 2));
}

export async function runIsolatedHost(target: HostTarget): Promise<void> {
  const source = requireEnvironment('OPENCHAMBER_HOST_SOURCE');
  const archive = requireEnvironment('OPENCHAMBER_PLUGIN_ZIP');
  const opencode = requireEnvironment('OPENCHAMBER_TEST_OPENCODE_BINARY');
  const lock = await readLock();
  await assertHostIdentity(source, lock);
  await mkdir(join(repositoryRoot, '.cache'), { recursive: true });
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
    const { entry } = await requireElectronAssets(source);
    const runRoot = await Bun.$`mktemp -d ${join(repositoryRoot, '.cache/git-graph-electron-XXXXXX')}`.text();
    const root = runRoot.trim();
    let app: ElectronApplication | undefined;
    try {
      const environment = electronLaunchEnvironment(root, opencode);
      const isolatedPaths = Object.values(hostEnvironment(root)).filter((path): path is string => path !== undefined);
      await Promise.all(isolatedPaths.map((path) => mkdir(path.endsWith('.json') ? resolve(path, '..') : path, { recursive: true })));
      const fixture = await createGitFixture(join(root, 'fixture'));
      await registerFixtureProject(environment.OPENCHAMBER_DATA_DIR!, fixture, true);
      app = await _electron.launch({
        executablePath: executable,
        args: await electronDevArguments(entry),
        cwd: resolve(source, 'packages/electron'),
        env: Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
      });
      const electronProcess = app.process();
      const processOutput: string[] = [];
      const captureProcessOutput = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
        const line = `${stream}: ${redactRuntimeSecrets(chunk.toString())}`;
        processOutput.push(line);
        if (processOutput.length > 100) processOutput.shift();
      };
      electronProcess.stdout?.on('data', (chunk: Buffer) => captureProcessOutput('stdout', chunk));
      electronProcess.stderr?.on('data', (chunk: Buffer) => captureProcessOutput('stderr', chunk));
      const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData')).catch((error) => {
        const detail = redactRuntimeSecrets(processOutput.join('')).trim() || '<no child output captured>';
        throw new Error(`Electron exited during startup (exit=${electronProcess.exitCode}, signal=${electronProcess.signalCode}): ${error instanceof Error ? error.message : String(error)}\n${detail}`);
      });
      if (userData !== environment.OPENCHAMBER_DESKTOP_USER_DATA_DIR) throw new Error('Electron did not use the isolated userData directory.');
      const electronVersion = await app.evaluate(() => process.versions.electron);
      if (!electronVersion) throw new Error('Electron runtime version was unavailable.');
      if (await app.evaluate(({ app: electronApp }) => electronApp.isDefaultProtocolClient('openchamber'))) {
        throw new Error('Test Electron is registered as the default openchamber:// handler; restore the installed app before native verification.');
      }
      const bounds = await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (!window) return null;
        window.setBounds({ width: 1280, height: 720 });
        return window.getBounds();
      });
      if (!bounds || bounds.width < 1280 || bounds.height < 720) throw new Error('Electron window could not use the required native verification bounds.');
      const page = await app.firstWindow();
      const connection = await discoverRuntimeConnection(page);
      const headers = authenticatedHeaders(connection);
      await installPackedPlugin(connection.apiBaseUrl, archive, headers);
      const guests = GuestCatalogSchema.parse(await fetch(`${connection.apiBaseUrl}/api/guests`, { headers }).then(async (response) => response.ok ? response.json() : Promise.reject(new Error(`Guest catalog failed: ${response.status}`))));
      const installed = guests.guests.find((guest) => guest.id === 'git-graph');
      if (!installed) throw new Error('Packed Git Graph plugin did not appear in the real host catalog.');
      if (!installed.statusEntry || installed.entry || installed.pageEntry) throw new Error('Git Graph must contribute only a status section.');
      await approveInstalledPlugin(connection.apiBaseUrl, installed, headers);
      const fixtureSession = await createFixtureSession(connection.apiBaseUrl, fixture, headers);
      await page.reload({ waitUntil: 'domcontentloaded' });
      if (fixtureSession) await page.getByText(fixtureSession.title, { exact: true }).first().click({ timeout: 30_000 });
      const failures = await verifyStatusSection(page, nativeEvidenceRoot(repositoryRoot), fixture);
      if (failures.length > 0) throw new Error(`electron actual-app checks failed:\n- ${failures.join('\n- ')}`);
      console.log(`PASS electron: installed packed Git Graph into an isolated real host with fixture ${basename(fixture)}.`);
    } finally {
      let observedPids: number[] = [];
      try {
        observedPids = await nativeProcessIds(root);
      } finally {
        try {
          await app?.close();
        } finally {
          // Verify the processes, not just the reaper's return value, before
          // removing the registry that identifies this run's detached children.
          await reapNativeProcesses(source, root, opencode, observedPids);
          await removeFixture(join(root, 'fixture'));
          await rm(root, { recursive: true, force: true });
        }
      }
    }
    return;
  }
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
    page.on('console', (message) => consoleMessages.push(redactRuntimeSecrets(`${message.type()}: ${message.text()}`)));
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
    const evidenceRoot = join(repositoryRoot, '.cache/evidence/web');
    const actualBehaviorFailures: string[] = [];
    actualBehaviorFailures.push(...await verifyStatusSection(page, evidenceRoot, fixture));
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
