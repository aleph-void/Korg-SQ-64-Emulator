import {test, expect} from './fixtures.js';

const firmware = () => {
  const buffer = Buffer.alloc(65536);
  buffer.writeUInt32LE(0x20040000, 0);
  buffer.writeUInt32LE(0x200009, 4);
  buffer.set([1, 0x30, 0xfd, 0xe7], 8); // Original counter loop.
  return {name: 'layout-probe.bin', mimeType: 'application/octet-stream', buffer};
};

test('workspace switching keeps the emulator running and preserves transfer settings', async ({page}) => {
  await page.goto('/');
  const panel = page.frameLocator('#emulator-frame');
  await expect(page.locator('#workspace-tab-emulator')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#device-tools')).toBeHidden();
  await panel.locator('#image').setInputFiles(firmware());
  await panel.locator('#reset').click();
  await expect(panel.locator('#status')).toContainText('Running');
  const before = await page.evaluate(() => window.sq64Emulator.state.report.board.ticks);
  await page.locator('#workspace-tab-tools').click();
  await page.locator('#channel').selectOption({value: '4'});
  await page.locator('#emulated').click();
  await expect(page.locator('#connection-state')).toHaveText('Browser emulator connected');
  await page.locator('#workspace-tab-emulator').click();
  await expect(panel.locator('#status')).toContainText('Running');
  await expect.poll(() => page.evaluate(() => window.sq64Emulator.state.report.board.ticks)).toBeGreaterThan(before);
  await page.locator('#workspace-tab-tools').click();
  await expect(page.locator('#channel')).toHaveValue('4');
});

test('tool tabs support keyboard navigation and retain the script draft', async ({page}) => {
  await page.goto('/emulator/');
  const firmwareTab = page.getByRole('tab', {name: 'Firmware', exact: true});
  await firmwareTab.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', {name: 'UI scripts', exact: true})).toBeFocused();
  await page.locator('#script-name').fill('Keep this draft');
  await page.locator('#script-actions').fill('[{"type":"wait","ms":123}]');
  await page.locator('#workbench-tab-midi').click();
  await expect(page.locator('#script-actions')).toBeHidden();
  await page.keyboard.press('End');
  await expect(page.locator('#workbench-tab-inspect')).toBeFocused();
  await expect(page.locator('#validate-image')).toBeVisible();
  await page.keyboard.press('Home');
  await expect(firmwareTab).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#workbench-tab-inspect')).toBeFocused();
  await page.locator('#workbench-tab-scripts').click();
  await expect(page.locator('#script-name')).toHaveValue('Keep this draft');
  await expect(page.locator('#script-actions')).toHaveValue('[{"type":"wait","ms":123}]');
});

for (const embedded of [true, false]) test(`${embedded ? 'embedded' : 'standalone'} panel and tool tabs fit desktop and mobile`, async ({page}, testInfo) => {
  await page.setViewportSize({width: 1440, height: 1000});
  await page.goto(embedded ? '/' : '/emulator/');
  const panel = embedded ? page.frameLocator('#emulator-frame') : page;
  await expect(panel.locator('[data-control]')).toHaveCount(85);
  const instrument = await panel.locator('.instrument').boundingBox();
  const tools = await panel.locator('.workbench-tools').boundingBox();
  expect(instrument.y + instrument.height).toBeLessThan(tools.y);
  expect(instrument.y + instrument.height).toBeLessThan(1000);
  await page.screenshot({path: testInfo.outputPath('desktop.png'), fullPage: true});
  // The embedded frame must shrink after a tall tool closes, not retain blank space.
  if (embedded) {
    await panel.locator('#workbench-tab-scripts').click();
    const scriptHeight = await page.locator('#emulator-frame').evaluate(el => el.offsetHeight);
    await panel.locator('#workbench-tab-midi').click();
    await expect.poll(() => page.locator('#emulator-frame').evaluate(el => el.offsetHeight)).toBeLessThan(scriptHeight);
    await panel.locator('#workbench-tab-firmware').click();
  }
  for (const width of [390, 320]) {
    await page.setViewportSize({width, height: 844});
    const frame = embedded ? page.frames().find(f => f.url().includes('/emulator/')) : page;
    for (const tab of ['firmware', 'scripts', 'midi', 'inspect']) {
      await panel.locator(`#workbench-tab-${tab}`).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    const display = await panel.locator('#display').boundingBox();
    expect(display.x).toBeGreaterThanOrEqual(0);
    expect(display.x + display.width).toBeLessThanOrEqual(width);
    await panel.locator('#workbench-tab-firmware').click();
  }
  await page.screenshot({path: testInfo.outputPath('mobile.png'), fullPage: true});
});
