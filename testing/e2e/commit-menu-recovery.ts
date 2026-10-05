import { expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { chromium, type Page } from 'playwright';

const fixture = new URL('../../plugins/git-graph/tests/e2e/commit-menu-recovery-fixture.tsx', import.meta.url).pathname;
const output = await mkdtemp(`${Bun.env.TMPDIR ?? '/tmp'}/git-graph-commit-menu-recovery-`);
const build = await Bun.build({ entrypoints: [fixture], outdir: output, target: 'browser', naming: '[name].[ext]' });
if (!build.success) throw new Error(build.logs.map((log) => log.message).join('\n'));
await Bun.write(`${output}/index.html`, '<!doctype html><link rel="stylesheet" href="/commit-menu-recovery-fixture.css"><div id="root"></div><script type="module" src="/commit-menu-recovery-fixture.js"></script>');
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/' || path === '/index.html') return new Response(Bun.file(`${output}/index.html`), { headers: { 'content-type': 'text/html' } });
    if (path === '/commit-menu-recovery-fixture.js') return new Response(Bun.file(`${output}/commit-menu-recovery-fixture.js`), { headers: { 'content-type': 'text/javascript' } });
    if (path === '/commit-menu-recovery-fixture.css') return new Response(Bun.file(`${output}/commit-menu-recovery-fixture.css`), { headers: { 'content-type': 'text/css' } });
    return new Response('not found', { status: 404 });
  },
});
const browser = await chromium.launch({ headless: true });
const screenshotDir = Bun.env.COMMIT_MENU_SCREENSHOT_DIR;

async function runScenario(scenario: string, test: (page: Page) => Promise<void>) {
  console.log(`Testing: ${scenario}`);
  const page = await browser.newPage();
  try {
    await page.goto(`${server.url}?scenario=${scenario}`);
    await test(page);
  } finally {
    await page.close();
  }
}

try {
  await runScenario('menu-view', async (page) => {
    await page.locator('[data-commit-menu-view="menu"]').waitFor({ timeout: 5000 });
    await page.addStyleTag({ content: ':root { --oc-elevated: #1b1b1f; --oc-elevated-fg: #eeeef2; --oc-hover: #303038; --oc-border: #555560; --oc-muted: #aaaab5; --oc-focus: #88aaff; --oc-error: #ef6a73; --oc-error-text: #ff9da4; --oc-primary: #7aa2ff; --oc-primary-text: #c9d8ff; } body { background: #111115; }' });
    const menu = page.getByRole('menu');
    expect(await menu.count()).toBe(1);
    expect(await menu.getByRole('menuitem').count()).toBe(11);
    expect(await menu.getByRole('menuitem').evaluateAll((items) => items.map((item) => getComputedStyle(item).borderTopWidth))).toEqual(Array(11).fill('0px'));
    const items = menu.getByRole('menuitem');
    await items.first().focus();
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-commit-menu-item'))).toBe('checkout');
    await page.keyboard.press('End');
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Reset hard');
    await page.keyboard.press('Home');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-commit-menu-item'))).toBe('copy-sha');
    // Pointer movement takes the highlight like a native menu, so hover and focus never mark two rows.
    await menu.locator('[data-commit-menu-item="revert"]').hover();
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-commit-menu-item'))).toBe('revert');
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await menu.evaluate((element) => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-commit-menu-item'))).toBe('copy-sha');
    const resetHard = menu.locator('[data-commit-menu-item="reset-hard"]');
    expect(await resetHard.getAttribute('class')).toContain('gcm-item--destructive');
    expect(await menu.getByRole('separator').count()).toBe(3);
    if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/commit-menu-dark.png` });
    await resetHard.click();
    await page.locator('[data-commit-menu-view="confirm"]').waitFor({ timeout: 5000 });
    if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/commit-menu-confirm-dark.png` });
  });

  // Scenario 1: stored unknown → Acknowledge → one compare/delete, record absent, state idle, settled callback once
  await runScenario('stored-unknown', async (page) => {
    await page.locator('[data-recovery-state="unknown"]').waitFor({ timeout: 5000 });
    await page.getByRole('button', { name: 'Acknowledge' }).click();
    await page.waitForFunction(() => !window.commitMenuRecovery.stored(), { timeout: 5000 });
    const results = await page.evaluate(() => ({ deletes: window.commitMenuRecovery.deletes(), settled: window.commitMenuRecovery.settled(), recoveryState: window.commitMenuRecovery.recoveryStates() }));
    expect(results.deletes).toBe(1);
    expect(results.settled).toBe(1);
    expect(results.recoveryState[results.recoveryState.length - 1]).toBe('idle');
  });

  // Scenario 2: running first poll → running UI/state is observed before terminal response
  await runScenario('running-first-poll', async (page) => {
    // Wait for the running state to be captured in the fixture state array
    await page.waitForFunction(() => window.commitMenuRecovery.recoveryStates().includes('running'), { timeout: 5000 });
    const recoveryStates = await page.evaluate(() => window.commitMenuRecovery.recoveryStates());
    // Verify running state is present in the sequence, which proves progress publication
    expect(recoveryStates).toContain('running');
  });

  // Scenario 3a: merge Continue → reaches confirm, then submits merge-continue
  await runScenario('merge-continue', async (page) => {
    // Wait for menu to load
    await page.locator('[data-commit-menu-view="conflict"]').waitFor({ timeout: 5000 });
    // Click Continue button (first appearance in conflict view)
    await page.getByRole('button', { name: 'Continue' }).first().click();
    // Should reach confirm view
    await page.locator('[data-commit-menu-view="confirm"]').waitFor({ timeout: 5000 });
    // Click Continue button again to submit
    await page.getByRole('button', { name: 'Continue' }).click();
    // Wait for mutation to complete
    await page.waitForFunction(() => window.commitMenuRecovery.mutations().length === 1, { timeout: 5000 });
    const mutations = await page.evaluate(() => window.commitMenuRecovery.mutations());
    expect(mutations).toEqual(['merge-continue']);
    expect(await page.evaluate(() => window.commitMenuRecovery.requests()[0]?.expectedSnapshot)).toBe('reviewed-snap');
  });

  // Scenario 3b: merge Abort → reaches confirm, then submits merge-abort
  await runScenario('merge-abort', async (page) => {
    // Wait for menu to load
    await page.locator('[data-commit-menu-view="conflict"]').waitFor({ timeout: 5000 });
    // Click Abort button (first appearance in conflict view)
    await page.getByRole('button', { name: 'Abort' }).first().click();
    // Should reach confirm view
    await page.locator('[data-commit-menu-view="confirm"]').waitFor({ timeout: 5000 });
    // Click Abort button again to submit
    await page.getByRole('button', { name: 'Abort' }).click();
    // Wait for mutation to complete
    await page.waitForFunction(() => window.commitMenuRecovery.mutations().length === 1, { timeout: 5000 });
    const mutations = await page.evaluate(() => window.commitMenuRecovery.mutations());
    expect(mutations).toEqual(['merge-abort']);
    expect(await page.evaluate(() => window.commitMenuRecovery.requests()[0]?.expectedSnapshot)).toBe('reviewed-snap');
  });

  // Scenario 4: snapshot-conflict failure → failure UI and durable record deleted
  await runScenario('mapped-failure-conflict', async (page) => {
    // Wait for menu to load
    await page.locator('[data-commit-menu-view="menu"]').waitFor({ timeout: 5000 });
    // Any mutation will fail with snapshot-conflict
    await page.getByRole('menuitem', { name: /checkout/i }).first().click();
    await page.locator('[data-commit-menu-view="confirm"]').getByRole('button', { name: /checkout/i }).click();
    // Should reach failure view
    await page.locator('[data-commit-menu-view="failure"]').waitFor({ timeout: 5000 });
    // Record should be deleted during cleanup
    const results = await page.evaluate(() => ({ deletes: window.commitMenuRecovery.deletes(), stored: window.commitMenuRecovery.stored() }));
    expect(results.deletes).toBe(1);
    expect(results.stored).toBe(false);
  });

  // Scenario 5: completed mutate + rejecting delete → success UI (not unknown), cleanup attempted
  await runScenario('cleanup-delete-failure', async (page) => {
    // Wait for menu to load
    await page.locator('[data-commit-menu-view="menu"]').waitFor({ timeout: 5000 });
    // Trigger a mutation
    await page.getByRole('menuitem', { name: /checkout/i }).first().click();
    await page.locator('[data-commit-menu-view="confirm"]').getByRole('button', { name: /checkout/i }).click();
    // Should reach success view despite delete failure
    await page.locator('[data-commit-menu-view="success"]').waitFor({ timeout: 5000 });
    // Verify delete was attempted even though it failed
    const results = await page.evaluate(() => ({ deletes: window.commitMenuRecovery.deletes(), stored: window.commitMenuRecovery.stored() }));
    expect(results.deletes).toBe(1);
    expect(results.stored).toBe(true);
  });

  // Scenario 6: unknown mutate (timeout-unknown) → unknown UI and durable record retained
  await runScenario('unknown-timeout', async (page) => {
    // Wait for menu to load
    await page.locator('[data-commit-menu-view="menu"]').waitFor({ timeout: 5000 });
    // Trigger a mutation
    await page.getByRole('menuitem', { name: /checkout/i }).first().click();
    await page.locator('[data-commit-menu-view="confirm"]').getByRole('button', { name: /checkout/i }).click();
    // Should reach unknown view
    await page.locator('[data-commit-menu-view="unknown"]').waitFor({ timeout: 5000 });
    // Record should be retained for owner recovery (no delete attempted for unknown outcomes)
    const results = await page.evaluate(() => ({ deletes: window.commitMenuRecovery.deletes(), stored: window.commitMenuRecovery.stored() }));
    expect(results.deletes).toBe(0);
    expect(results.stored).toBe(true);
  });

  for (const scenario of ['attention-cleared', 'attention-changed']) {
    await runScenario(scenario, async (page) => {
      await page.locator('[data-commit-menu-view="conflict"]').getByRole('button', { name: 'Continue' }).click();
      if (scenario === 'attention-cleared') await page.locator('[data-commit-menu-view="menu"]').waitFor();
      else await page.locator('[data-commit-menu-view="conflict"]').waitFor();
      expect(await page.locator('[data-commit-menu-view="confirm"]').count()).toBe(0);
      expect(await page.evaluate(() => window.commitMenuRecovery.mutations())).toEqual([]);
    });
  }
  await runScenario('initial-status-error', async (page) => {
    await page.locator('[data-commit-menu-view="failure"]').waitFor();
    expect(await page.locator('[data-commit-menu-view="menu"]').count()).toBe(0);
    expect(await page.evaluate(() => window.commitMenuRecovery.mutations())).toEqual([]);
  });
  for (const scenario of ['storage-write-error', 'mutate-transport-error']) {
    await runScenario(scenario, async (page) => {
      await page.locator('[data-commit-menu-view="menu"]').getByRole('menuitem', { name: /checkout/i }).click();
      await page.locator('[data-commit-menu-view="confirm"]').getByRole('button', { name: /checkout/i }).click();
      await page.locator(`[data-commit-menu-view="${scenario === 'storage-write-error' ? 'failure' : 'unknown'}"]`).waitFor();
      expect(await page.evaluate(() => window.commitMenuRecovery.mutations().length)).toBe(scenario === 'storage-write-error' ? 0 : 1);
      expect(await page.evaluate(() => window.commitMenuRecovery.stored())).toBe(scenario !== 'storage-write-error');
    });
  }
  console.log('All recovery scenarios passed');
} finally {
  await browser.close();
  server.stop(true);
  await rm(output, { recursive: true, force: true });
}
