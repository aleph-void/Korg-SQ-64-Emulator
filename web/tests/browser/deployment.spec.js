import {test, expect} from './fixtures.js';
test('export works beneath a repository path with no native service', async ({page}) => {
  const failed = []; page.on('pageerror', e => failed.push(e.message));
  page.on('response', r => { if (!r.ok()) failed.push(`${r.status()} ${r.url()}`); });
  await page.goto('/dist/'); await page.locator('#browser-workbench[open]').waitFor();
  const panel = page.frameLocator('#emulator-frame');
  await panel.locator('#load-probe').click(); await expect(panel.locator('#status')).toContainText('Running');
  await panel.locator('#validate-image').click();
  await expect(panel.locator('#validation-summary')).toContainText('FAIL · 0 passed · 1 failed · 6 not run');
  await page.locator('#emulated').click();
  await expect(page.locator('#connection-state')).toHaveText('Browser emulator connected');
  await expect(page.locator('link[rel=canonical]')).toHaveAttribute('href', 'https://sq64.alephvoid.com/');
  expect(failed).toEqual([]);
});
test('expanded workbench fits desktop and mobile layouts', async ({page}, testInfo) => {
  await page.setViewportSize({width: 1440, height: 1000});
  await page.goto('/'); await page.locator('#browser-workbench[open]').waitFor();
  await expect(page.frameLocator('#emulator-frame').locator('[data-control]')).toHaveCount(85);
  await page.screenshot({path: testInfo.outputPath('desktop.png'), fullPage: true});
  await page.setViewportSize({width: 390, height: 844});
  await page.screenshot({path: testInfo.outputPath('mobile.png'), fullPage: true});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const frame = page.frames().find(f => f.url().includes('emulator/index.html'));
  expect(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
