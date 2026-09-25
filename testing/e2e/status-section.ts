import { expect } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const fixture = new URL('../../plugins/git-graph/tests/e2e/status-section-fixture.tsx', import.meta.url).pathname;
const evidence = new URL('../../.cache/evidence/', import.meta.url);
await mkdir(evidence, { recursive: true });
const output = await mkdtemp(`${Bun.env.TMPDIR ?? '/tmp'}/git-graph-status-section-`);
const build = await Bun.build({ entrypoints: [fixture], outdir: output, target: 'browser', naming: '[name].[ext]' });
if (!build.success) throw new Error(build.logs.map((log) => log.message).join('\n'));
await Bun.write(`${output}/index.html`, '<!doctype html><link rel="stylesheet" href="/status-section-fixture.css"><div id="root"></div><script type="module" src="/status-section-fixture.js"></script>');
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/' || path === '/index.html') return new Response(Bun.file(`${output}/index.html`), { headers: { 'content-type': 'text/html' } });
    if (path === '/status-section-fixture.js') return new Response(Bun.file(`${output}/status-section-fixture.js`), { headers: { 'content-type': 'text/javascript' } });
    if (path === '/status-section-fixture.css') return new Response(Bun.file(`${output}/status-section-fixture.css`), { headers: { 'content-type': 'text/css' } });
    return new Response('not found', { status: 404 });
  },
});
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 320, height: 480 } });
  await page.goto(server.url.toString());
  const status = page.locator('[data-git-graph-status="true"]');
  await status.locator('[data-git-graph-status-commit]').first().waitFor();
  await status.locator('.git-compact-graph-segment svg').first().waitFor();
  expect(await status.getByRole('tablist', { name: 'History mode' }).count()).toBe(1);
  expect(await status.getByRole('button', { name: /Open commit Commit fixture-a by Test/ }).count()).toBe(1);
  const rowBoxes = await status.locator('.git-compact-history-row').evaluateAll((rows) => rows.map((row) => {
    const box = row.getBoundingClientRect();
    return { top: box.top, height: box.height };
  }));
  expect(rowBoxes.every((row) => row.height === 22)).toBe(true);
  expect(rowBoxes.slice(1).every((row, index) => row.top === rowBoxes[index]!.top + 22)).toBe(true);
  await page.screenshot({ path: fileURLToPath(new URL('status-graph-320.png', evidence)) });
  await page.setViewportSize({ width: 282, height: 480 });
  await page.screenshot({ path: fileURLToPath(new URL('status-graph-282.png', evidence)) });

  const initialRequests = await page.evaluate(() => window.statusSection.requestCount());
  await status.locator('[data-git-graph-status-commit]').first().click();
  await page.evaluate(() => window.statusSection.rerender());
  expect(await page.evaluate(() => window.statusSection.requestCount())).toBe(initialRequests);

  const history = status.locator('.git-status-commits');
  await page.evaluate(() => window.statusSection.triggerHistoryEnd());
  await page.waitForFunction(() => document.querySelectorAll('[data-git-graph-status-commit]').length === 101);
  const commitIds = await history.locator('[data-git-graph-status-commit]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-git-graph-status-commit')));
  expect(new Set(commitIds).size).toBe(101);
  expect(commitIds.at(-1)).toBe('0000000000000000000000000000000000000064');

  await page.getByRole('tab', { name: 'All', exact: true }).click();
  await page.waitForFunction(() => window.statusSection.lastHistoryRefs().join(',') === '*');
  await page.getByRole('tab', { name: 'Manual', exact: true }).click();
  await page.waitForFunction(() => window.statusSection.lastHistoryRefs().join(',') === 'HEAD');
  await status.getByRole('checkbox', { name: 'main', exact: true }).check();
  await page.waitForFunction(() => window.statusSection.lastHistoryRefs().join(',') === 'refs/heads/main');
  await page.getByRole('tab', { name: 'Auto', exact: true }).click();
  await page.waitForFunction(() => window.statusSection.lastHistoryRefs().join(',') === 'refs/heads/main,refs/remotes/origin/main');

  await page.evaluate(() => window.statusSection.delayNextPage());
  await page.evaluate(() => window.statusSection.triggerHistoryEnd());
  await page.waitForFunction(() => window.statusSection.pendingHistoryCount() === 1);
  await page.getByRole('tab', { name: 'All', exact: true }).click();
  await page.waitForFunction(() => window.statusSection.lastHistoryRefs().join(',') === '*');
  await page.evaluate(() => window.statusSection.resolveDelayedHistory());
  await page.waitForFunction(() => document.querySelectorAll('[data-git-graph-status-commit]').length === 100);
  expect(await status.getByRole('alert').count()).toBe(0);

  await page.evaluate(() => window.statusSection.delayNextPage());
  await page.evaluate(() => window.statusSection.triggerHistoryEnd());
  await page.waitForFunction(() => window.statusSection.pendingHistoryCount() === 1);
  await page.getByRole('tab', { name: 'Auto', exact: true }).click();
  await page.waitForFunction(() => window.statusSection.lastHistoryRefs().join(',') === 'refs/heads/main,refs/remotes/origin/main');
  await page.evaluate(() => window.statusSection.rejectDelayedHistory());
  await page.waitForFunction(() => document.querySelectorAll('[data-git-graph-status-commit]').length === 100);
  expect(await status.getByRole('alert').count()).toBe(0);

  await page.evaluate(() => window.statusSection.failNextPage());
  await page.evaluate(() => window.statusSection.triggerHistoryEnd());
  await status.getByRole('alert').waitFor();
  expect(await status.locator('[data-git-graph-status-commit]').count()).toBe(100);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.waitForFunction(() => !document.body.textContent?.includes('Unable to load commits.'));

  await page.evaluate(() => window.statusSection.delayHistory('/fixture-a'));
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.waitForFunction(() => window.statusSection.pendingHistoryCount() === 1);
  await page.evaluate(() => window.statusSection.setDirectory('/fixture-b'));
  await page.getByText('Commit fixture-b', { exact: true }).waitFor();
  await page.evaluate(() => window.statusSection.resolveDelayedHistory());
  expect(await page.getByText('Commit fixture-a', { exact: true }).count()).toBe(0);

  await page.evaluate(() => window.statusSection.setDirectory('/fixture-a'));
  await page.getByText('Commit fixture-a', { exact: true }).waitFor();
  await page.evaluate(() => window.statusSection.deferStorageReads());
  await page.evaluate(() => window.statusSection.setDirectory('/fixture-b'));
  await page.waitForFunction(() => window.statusSection.pendingStorageReads() === 1);
  await page.evaluate(() => window.statusSection.setDirectory('/fixture-a'));
  await page.waitForFunction(() => window.statusSection.pendingStorageReads() === 2);
  await page.evaluate(() => window.statusSection.resolveDelayedStorageRead());
  await page.evaluate(() => window.statusSection.resolveDelayedStorageRead());
  await page.getByText('Commit fixture-a', { exact: true }).waitFor();

  await page.evaluate(() => window.statusSection.setDirectory(null));
  await page.waitForFunction(() => document.querySelectorAll('[data-git-graph-status-commit]').length === 0);
  expect(await status.locator('[data-git-graph-status-commit]').count()).toBe(0);
  expect(await status.locator('[aria-busy="true"]').count()).toBe(0);

  await page.evaluate(() => window.statusSection.setStoredPreferences({ mode: 'manual', refs: ['refs/heads/stale'] }));
  await page.evaluate(() => window.statusSection.setDirectory('/restored'));
  await page.waitForFunction(() => window.statusSection.lastHistoryRefs().join(',') === 'HEAD');
  expect(await status.getByRole('checkbox', { name: 'main', exact: true }).isChecked()).toBe(false);

  await page.evaluate(() => window.statusSection.failNextStorageSave());
  await page.getByRole('tab', { name: 'All', exact: true }).click();
  await page.getByText('Could not save history preferences.', { exact: true }).waitFor();
  await page.getByRole('tab', { name: 'All', exact: true }).click();
  await page.waitForFunction(() => !document.body.textContent?.includes('Could not save history preferences.'));

  await page.locator('[data-git-graph-status-commit]').first().click();
  expect(await page.evaluate(() => window.statusSection.openedCommit())).toBe('0123456789abcdef0123456789abcdef01234567');
  await page.evaluate(() => window.statusSection.rejectNextOpen());
  await page.locator('[data-git-graph-status-commit]').first().click();
  await status.getByRole('alert').waitFor();

  await page.evaluate(() => window.statusSection.triggerResize());
  const heights = await page.evaluate(() => window.statusSection.heights());
  expect(heights.length).toBeGreaterThan(0);
  expect(heights.every((height) => height >= 0 && height <= 320)).toBe(true);

  const readsBeforeFailure = await page.evaluate(() => window.statusSection.storageReads());
  await page.evaluate(() => window.statusSection.failNextStorageRead());
  await page.evaluate(() => window.statusSection.setDirectory('/retry'));
  await page.waitForFunction((before) => window.statusSection.storageReads() > before, readsBeforeFailure);
  const readsBeforeRetry = await page.evaluate(() => window.statusSection.storageReads());
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.waitForFunction((before) => window.statusSection.storageReads() > before, readsBeforeRetry);
  expect(await page.evaluate(() => window.statusSection.storageReads())).toBeGreaterThan(readsBeforeRetry);
} finally {
  await browser.close();
  server.stop(true);
  await rm(output, { recursive: true, force: true });
}
