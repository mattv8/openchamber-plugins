import { expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { chromium } from 'playwright';

const fixture = new URL('../../plugins/git-graph/tests/e2e/mutation-guard-fixture.tsx', import.meta.url).pathname;
const output = await mkdtemp(`${Bun.env.TMPDIR ?? '/tmp'}/git-graph-mutation-guard-`);
const build = await Bun.build({ entrypoints: [fixture], outdir: output, target: 'browser', naming: 'fixture.js' });
if (!build.success) throw new Error(build.logs.map((log) => log.message).join('\n'));
await Bun.write(`${output}/index.html`, '<!doctype html><div id="root"></div><script type="module" src="/fixture.js"></script>');
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/' || path === '/index.html') return new Response(Bun.file(`${output}/index.html`), { headers: { 'content-type': 'text/html' } });
    if (path === '/fixture.js') return new Response(Bun.file(`${output}/fixture.js`), { headers: { 'content-type': 'text/javascript' } });
    return new Response('not found', { status: 404 });
  },
});
const browser = await chromium.launch({ headless: true });

try {
  const safetyPage = await browser.newPage();
  await safetyPage.goto(server.url.toString());
  await safetyPage.getByRole('button', { name: 'Unstaged' }).click();
  await safetyPage.getByRole('button', { name: 'Stage hunk', exact: true }).first().waitFor();

  await safetyPage.getByRole('button', { name: 'Discard hunk', exact: true }).first().click();
  const confirmation = safetyPage.getByRole('alertdialog');
  await confirmation.waitFor();
  await safetyPage.evaluate(() => { window.mutationGuard.deferNextOpen(); window.mutationGuard.switchDirectory('/fixture-b'); });
  await safetyPage.waitForFunction(() => window.mutationGuard.pendingOpenCount() === 1);
  await confirmation.getByRole('button', { name: 'Confirm' }).click();
  await safetyPage.waitForTimeout(0);
  expect(await safetyPage.evaluate(() => window.mutationGuard.mutationCount())).toBe(0);
  await safetyPage.getByRole('button', { name: 'Push', exact: true }).click();
  await safetyPage.waitForTimeout(0);
  expect(await safetyPage.evaluate(() => window.mutationGuard.mutationCount())).toBe(0);
  await safetyPage.evaluate(() => window.mutationGuard.resolveOpen());
  await safetyPage.waitForFunction(() => window.mutationGuard.latestReadRepositoryId() === 'repo-b');
  await safetyPage.getByRole('button', { name: 'Push', exact: true }).click();
  await safetyPage.waitForFunction(() => window.mutationGuard.mutationCount() === 1);
  expect(await safetyPage.evaluate(() => window.mutationGuard.mutationRepositoryId(0))).toBe('repo-b');
  await safetyPage.close();

  const page = await browser.newPage();
  await page.goto(server.url.toString());
  await page.getByRole('button', { name: 'Unstaged' }).click();
  await page.getByRole('button', { name: 'Stage hunk', exact: true }).first().waitFor();

  await page.getByRole('button', { name: 'Fetch' }).evaluate((button) => { const control = button as HTMLButtonElement; control.click(); control.click(); });
  await page.waitForFunction(() => window.mutationGuard.mutationCount() === 1);

  await page.evaluate(() => window.mutationGuard.timeoutFirst());
  const unknownAlert = page.getByRole('alert').filter({ hasText: 'Git operation is still running' });
  await unknownAlert.waitFor();

  for (const name of ['Push', 'Stage', 'Stage hunk']) {
    const button = page.getByRole('button', { name, exact: true }).first();
    expect(await button.evaluate((element) => (element as HTMLButtonElement).disabled)).toBe(true);
    await button.evaluate((element) => { const control = element as HTMLButtonElement; control.disabled = false; control.click(); });
  }
  expect(await page.evaluate(() => window.mutationGuard.mutationCount())).toBe(1);

  await unknownAlert.getByRole('button', { name: 'Refresh' }).click();
  await page.waitForFunction(() => window.mutationGuard.refreshCount() === 1);
  expect(await page.evaluate(() => window.mutationGuard.mutationCount())).toBe(1);

  await page.getByRole('button', { name: 'Push', exact: true }).click();
  await page.waitForFunction(() => window.mutationGuard.mutationCount() === 2);

  const switchPage = await browser.newPage();
  await switchPage.goto(server.url.toString());
  const refresh = switchPage.getByRole('button', { name: 'Refresh', exact: true });
  await switchPage.getByRole('button', { name: 'Fetch' }).click();
  await switchPage.waitForFunction(() => window.mutationGuard.mutationCount() === 1);
  expect(await refresh.evaluate((button) => (button as HTMLButtonElement).disabled)).toBe(true);

  await switchPage.evaluate(() => window.mutationGuard.switchDirectory('/fixture-b'));
  const bPush = switchPage.getByRole('button', { name: 'Push', exact: true });
  await bPush.waitFor();
  await bPush.click();
  await switchPage.waitForFunction(() => window.mutationGuard.mutationCount() === 2);

  await switchPage.evaluate(() => window.mutationGuard.timeoutMutation(0));
  expect(await bPush.evaluate((button) => (button as HTMLButtonElement).disabled)).toBe(true);
  await switchPage.evaluate(() => window.mutationGuard.completeMutation(1));
  await switchPage.waitForFunction(() => !document.querySelector<HTMLButtonElement>('header button[aria-label="Refresh"]')?.disabled);

  await switchPage.evaluate(() => window.mutationGuard.switchDirectory('/fixture-a'));
  const restoredUnknown = switchPage.getByRole('alert').filter({ hasText: 'Git operation is still running' });
  await restoredUnknown.waitFor();
  expect(await switchPage.getByRole('button', { name: 'Push', exact: true }).evaluate((button) => (button as HTMLButtonElement).disabled)).toBe(true);
  await switchPage.getByRole('button', { name: 'Push', exact: true }).evaluate((button) => { const control = button as HTMLButtonElement; control.disabled = false; control.click(); });
  expect(await switchPage.evaluate(() => window.mutationGuard.mutationCount())).toBe(2);
} finally {
  await browser.close();
  server.stop(true);
  await rm(output, { recursive: true, force: true });
}
