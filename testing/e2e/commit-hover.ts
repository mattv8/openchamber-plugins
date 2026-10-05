import { expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { chromium } from 'playwright';

const fixture = new URL('../../plugins/git-graph/tests/e2e/commit-hover-fixture.tsx', import.meta.url).pathname;
const output = await mkdtemp(`${Bun.env.TMPDIR ?? '/tmp'}/git-graph-commit-hover-`);
const build = await Bun.build({ entrypoints: [fixture], outdir: output, target: 'browser', naming: '[name].[ext]' });
if (!build.success) throw new Error(build.logs.map((log) => log.message).join('\n'));
await Bun.write(`${output}/index.html`, '<!doctype html><link rel="stylesheet" href="/commit-hover-fixture.css"><style>.git-compact-history-row { width: 320px; height: 24px; }</style><div id="root"></div><script type="module" src="/commit-hover-fixture.js"></script>');
const server = Bun.serve({ port: 0, fetch(request) { const path = new URL(request.url).pathname; if (path === '/' || path === '/index.html') return new Response(Bun.file(`${output}/index.html`), { headers: { 'content-type': 'text/html' } }); if (path === '/commit-hover-fixture.js') return new Response(Bun.file(`${output}/commit-hover-fixture.js`), { headers: { 'content-type': 'text/javascript' } }); if (path === '/commit-hover-fixture.css') return new Response(Bun.file(`${output}/commit-hover-fixture.css`), { headers: { 'content-type': 'text/css' } }); return new Response('not found', { status: 404 }); } });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.route('https://avatars.githubusercontent.com/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/u/1') await route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+9+1hWQAAAABJRU5ErkJggg==', 'base64') });
    else await route.fulfill({ status: 404, body: 'not found' });
  });
  const browserEvents: string[] = [];
  const avatarRequests: string[] = [];
  page.on('request', (request) => { if (request.url().includes('avatars.githubusercontent.com')) avatarRequests.push(request.url()); });
  page.on('console', (message) => browserEvents.push(`console:${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => browserEvents.push(`pageerror: ${error.stack ?? error.message}`));
  const phase = async <T>(label: string, action: () => Promise<T>): Promise<T> => {
    console.log(`[commit-hover] ${label}: start`);
    try {
      const result = await action();
      console.log(`[commit-hover] ${label}: ok`);
      return result;
    } catch (error) {
      const state = await page.evaluate(() => ({
        readyState: document.readyState,
        row: (() => { const element = document.querySelector('[data-git-graph-status-commit]'); return element ? { html: element.outerHTML, rect: element.getBoundingClientRect().toJSON() } : null; })(),
        requests: window.commitHover?.requests?.(),
        popovers: window.commitHover?.popovers?.(),
      })).catch((diagnosticError) => ({ diagnosticError: String(diagnosticError) }));
      throw new Error(`[commit-hover] ${label} failed\nstate=${JSON.stringify(state, null, 2)}\nbrowser=${browserEvents.join('\n') || '(none)'}`, { cause: error });
    }
  };
   await phase('navigate fixture', () => page.goto(server.url.toString()));
  const row = page.locator('[data-git-graph-status-commit]').first();
  await phase('wait for commit row', () => row.waitFor());
  expect(await row.getAttribute('aria-label')).toBe('Toggle changed files for Subject by Author; tags: plain-tag, colored-tag');
  expect(await row.getAttribute('aria-expanded')).toBe('false');
  expect(await row.getAttribute('aria-controls')).toBe(`git-status-files-${'a'.repeat(40)}`);
  await page.evaluate(() => window.commitHover.rerender());
  expect(await row.getAttribute('aria-label')).toMatch(/Author; tags: plain-tag, colored-tag/);
  await page.evaluate(() => window.commitHover.setAuthor('Updated Author'));
  expect(await row.getAttribute('aria-label')).toMatch(/Updated Author; tags: plain-tag, colored-tag/);
  await page.evaluate(() => window.commitHover.setEnabled(false));
  await phase('wait for initial hover disposal', () => page.waitForFunction(() => !document.querySelector('[data-git-graph-status-commit]')?.hasAttribute('aria-haspopup')));
  expect(await row.getAttribute('aria-label')).toMatch(/Updated Author; tags: plain-tag, colored-tag/);
  await row.click();
  expect(await row.getAttribute('aria-expanded')).toBe('true');
  expect(await page.locator(`#git-status-files-${'a'.repeat(40)}`).isVisible()).toBe(true);
  await row.click();
  await page.mouse.move(0, 0);

  await page.evaluate(() => window.commitHover.setEnabled(true));
  await phase('wait for repository A hover binding', () => page.waitForFunction(() => document.querySelector('[data-git-graph-status-commit]')?.getAttribute('aria-haspopup') === 'dialog'));
  await row.hover();
  await phase('wait for repository A preload', () => page.waitForFunction(() => window.commitHover.requests().some((request) => request.operation === 'read' && request.read === 'commit-summary')));
  const summaryRequest = await page.evaluate(() => window.commitHover.requests().find((request) => request.operation === 'read' && request.read === 'commit-summary'));
  expect(summaryRequest).toMatchObject({ commit: 'a'.repeat(40), repositoryId: 'repo-a' });
  await phase('wait for repository A popover', () => page.waitForFunction(() => window.commitHover.popovers().length === 1));
  expect(await page.evaluate(() => window.commitHover.popovers()[0])).toMatchObject({ data: { summary: { message: 'summary from repository A' } } });

  // Begin a new hover intent after switching repositories. The same DOM row is
  // retained, so hovering it twice without leaving emits no second pointerenter.
  await page.mouse.move(0, 0);
  await page.evaluate(() => window.commitHover.setEnabled(false));
  await phase('wait for repository A hover disposal', () => page.waitForFunction(() => !document.querySelector('[data-git-graph-status-commit]')?.hasAttribute('aria-haspopup')));
  await page.evaluate(() => window.commitHover.setRepository('repo-b'));
  await page.evaluate(() => window.commitHover.setEnabled(true));
  await phase('wait for repository B hover binding', () => page.waitForFunction(() => document.querySelector('[data-git-graph-status-commit]')?.getAttribute('aria-haspopup') === 'dialog'));
  await row.hover();
  await phase('wait for repository B preload', () => page.waitForFunction(() => window.commitHover.requests().some((request) => request.operation === 'read' && request.read === 'commit-summary' && request.repositoryId === 'repo-b')));
  await phase('wait for repository B popover', () => page.waitForFunction(() => window.commitHover.popovers().length === 2));
  expect(await page.evaluate(() => window.commitHover.popovers()[1])).toMatchObject({ data: { summary: { message: 'summary from repository B' } } });

  const requestCount = await page.evaluate(() => window.commitHover.requests().length);
  await page.evaluate(() => window.commitHover.menuOpen());
  await page.mouse.move(0, 0);
  await row.hover();
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.commitHover.requests().length)).toBe(requestCount);
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.commitHover.popovers().length)).toBe(2);
  await page.evaluate(() => window.commitHover.menuClosed());

  // A menu can open between pointerenter and the 75ms preload deadline.
  await page.mouse.move(0, 0);
  await page.evaluate(() => window.commitHover.setEnabled(false));
  await phase('wait for final disposal', () => page.waitForFunction(() => !document.querySelector('[data-git-graph-status-commit]')?.hasAttribute('aria-haspopup')));
  await page.evaluate(() => { window.commitHover.setRepository('repo-a'); window.commitHover.setEnabled(true); });
  await phase('wait for repository A remount', () => page.waitForFunction(() => document.querySelector('[data-git-graph-status-commit]')?.getAttribute('aria-haspopup') === 'dialog'));
  const beforeDwell = await page.evaluate(() => window.commitHover.requests().filter((request) => request.operation === 'read' && request.read === 'commit-summary').length);
  await row.dispatchEvent('pointerenter', { pointerType: 'mouse' });
  await page.evaluate(() => window.commitHover.menuOpen());
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.commitHover.requests().filter((request) => request.operation === 'read' && request.read === 'commit-summary').length)).toBe(beforeDwell);
  expect(await page.evaluate(() => window.commitHover.popovers().length)).toBe(2);
   await page.evaluate(() => window.commitHover.menuClosed());
   await phase('navigate valid avatar fixture', () => page.goto(`${server.url}?scenario=avatar-valid`));
   await phase('wait for author lookup despite preloaded summary', () => page.waitForFunction(() => window.commitHover.requests().some((request) => request.operation === 'read' && request.read === 'commit-author')));
   await phase('wait for loaded avatar', () => page.locator('[data-git-commit-hover-avatar] img').waitFor());
   expect(await page.locator('[data-git-commit-hover-avatar] img').evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
   expect(await page.locator('.git-commit-hover-login').textContent()).toBe('@octocat');
   expect(await page.locator('.git-commit-hover-email').count()).toBe(0);
    expect(await page.locator('[role="alert"]').count()).toBe(0);
    // The host frame already draws the popover border; the card must not add an inset second one.
    const edges = await page.locator('[data-git-graph-commit-hover]').evaluate((card) => {
      const style = getComputedStyle(card);
      return { border: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth], cardWidth: card.getBoundingClientRect().width, viewport: document.documentElement.clientWidth };
    });
    expect(edges.border).toEqual(['0px', '0px', '0px', '0px']);
    expect(edges.cardWidth).toBe(edges.viewport);
    await page.locator('[data-git-commit-hover-avatar] img').dispatchEvent('error');
    expect(await page.locator('[data-git-commit-hover-avatar] img').count()).toBe(0);
    expect(await page.locator('[data-git-commit-hover-login]').textContent()).toBe('@octocat');

   await phase('navigate failed avatar fixture', () => page.goto(`${server.url}?scenario=avatar-failure`));
   await phase('keep initials after image failure', () => page.waitForFunction(() => document.querySelector('.git-commit-hover-login')?.textContent === '@broken'));
   expect(await page.locator('[data-git-commit-hover-avatar] img').count()).toBe(0);
   expect(await page.locator('[data-git-commit-hover-avatar]').textContent()).toBe('A');

   await phase('navigate unavailable avatar fixture', () => page.goto(`${server.url}?scenario=avatar-error`));
   await phase('keep initials after service failure', () => page.locator('[data-git-commit-hover-avatar]').waitFor());
   expect(await page.locator('[data-git-commit-hover-login]').count()).toBe(0);
   expect(await page.locator('[role="alert"]').count()).toBe(0);

   await phase('navigate unsafe avatar fixture', () => page.goto(`${server.url}?scenario=avatar-unsafe`));
   await phase('wait for unsafe login', () => page.waitForFunction(() => document.querySelector('.git-commit-hover-login')?.textContent === '@unsafe'));
   expect(await page.locator('[data-git-commit-hover-avatar] img').count()).toBe(0);
   expect(avatarRequests.filter((url) => url.includes('evil.test'))).toEqual([]);

   await phase('navigate stale avatar fixture', () => page.goto(`${server.url}?scenario=avatar-stale`));
   await phase('wait for first author request', () => page.waitForFunction(() => window.commitHover.requests().filter((request) => request.operation === 'read' && request.read === 'commit-author').length === 1));
   await page.evaluate(() => window.commitHover.setAvatarDirectory('/avatar-b'));
   await phase('wait for B author request', () => page.waitForFunction(() => window.commitHover.requests().filter((request) => request.operation === 'read' && request.read === 'commit-author').length === 2));
   await page.evaluate(() => window.commitHover.setAvatarDirectory('/avatar-a'));
   await phase('wait for final A author request', () => page.waitForFunction(() => window.commitHover.requests().filter((request) => request.operation === 'read' && request.read === 'commit-author').length === 3));
   await page.evaluate(() => { window.commitHover.resolveAvatarAuthor('/avatar-b', 'stale-b'); window.commitHover.resolveAvatarAuthor('/avatar-a', 'stale-a'); window.commitHover.resolveAvatarAuthor('/avatar-a', 'active-a'); });
   await phase('wait for active author', () => page.waitForFunction(() => document.querySelector('.git-commit-hover-login')?.textContent === '@active-a'));
   expect(await page.locator('.git-commit-hover-login').textContent()).toBe('@active-a');
   expect(await page.locator('[data-git-commit-hover-avatar] img').count()).toBe(1);
   console.log('PASS commit-hover: accessible name, row expansion, SHA preload, repository scope, menu suppression');
} finally { await browser.close(); server.stop(true); await rm(output, { recursive: true, force: true }); }
