import {test, expect} from './fixtures.js';
import {syntheticVsb} from '../fixtures.js';

function firmware(corrupt = false) {
  const bytes = syntheticVsb(), view = new DataView(bytes.buffer);
  view.setUint32(260, 0x200009, true); bytes.set([1, 0x30, 0xfd, 0xe7], 264);
  view.setUint16(256 + 65534, 0, true);
  let sum = 0; for (let i = 256; i < 256 + 65536; i += 2) sum += view.getUint16(i, true);
  view.setUint16(256 + 65534, -sum & 65535, true);
  if (corrupt) bytes[0x110] ^= 1;
  return {name: 'synthetic-conformance.vsb', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes)};
}

async function downloaded(page, trigger) {
  const pending = page.waitForEvent('download'); await trigger();
  const stream = await (await pending).createReadStream(), chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

test('Validate Image preserves a stopped debugger and exports the exact loaded image checks', async ({page}) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/'); await page.locator('#browser-workbench summary').click();
  const panel = page.frameLocator('#emulator-frame');
  await expect(panel.getByRole('button', {name: 'Validate Image', exact: true})).toBeDisabled();
  await panel.locator('#image').setInputFiles(firmware());
  await panel.getByText('Developer debugging', {exact: true}).click();
  await panel.locator('#debug-enabled').check();
  await panel.locator('#debug-breakpoints').fill('0x200008'); await panel.locator('#debug-apply').click();
  await panel.locator('#run').click(); await expect(panel.locator('#debug-stop')).toContainText('Breakpoint');
  await panel.locator('#debug-step').click(); await panel.locator('#run').click();
  await expect(panel.locator('#ticks')).toHaveText('2');
  const before = await page.evaluate(() => window.sq64Emulator.request('state'));
  await panel.locator('#validate-image').click();
  await expect(panel.locator('#validation-summary')).toHaveText('PASS · 7 passed · 0 failed · 0 not run');
  await expect(panel.locator('#validation-rows tr')).toHaveCount(7);
  const after = await page.evaluate(() => window.sq64Emulator.request('state'));
  expect(after.report.debug).toEqual(before.report.debug);
  expect(after.report.board.ticks).toBe(before.report.board.ticks); expect(after.running).toBe(false);
  expect(after.report.conformance.imageSha256).toBe(before.report.imageSha256);
  const report = await downloaded(page, () => panel.locator('#validation-save').click());
  expect(report).toEqual(after.report.conformance);
  const debugReport = await downloaded(page, () => panel.locator('#debug-save').click());
  expect(debugReport.conformance).toEqual(report); expect(debugReport.debug).toEqual(before.report.debug);
  await panel.locator('#reset').click(); await panel.locator('#validate-image').click();
  await expect(panel.locator('#validation-summary')).toContainText('PASS');
  expect((await page.evaluate(() => window.sq64Emulator.request('state'))).report.conformance).toEqual(report);
  await panel.locator('#run').click(); await expect(panel.locator('#debug-stop')).toContainText('Breakpoint');
  await panel.locator('#debug-step').click(); await expect(panel.locator('#pc')).toHaveText('0x0020000a');
  expect(errors).toEqual([]);
});

test('validation reports failures, clears replacement results and respects transaction locks', async ({page}) => {
  await page.goto('/emulator/');
  await page.locator('#image').setInputFiles(firmware(true));
  await page.locator('#validate-image').click();
  await expect(page.locator('#validation-summary')).toContainText('FAIL · 6 passed · 1 failed');
  await expect(page.locator('#validation-rows tr[data-status=fail]')).toContainText('PKG-005');
  await page.locator('#image').setInputFiles(firmware());
  await expect(page.locator('#validation-results')).toBeHidden();
  await expect(page.locator('#validation-save')).toBeDisabled();
  await page.locator('#run').click(); await expect(page.locator('#status')).toContainText('Running');
  await page.locator('#validate-image').click(); await expect(page.locator('#validation-summary')).toContainText('PASS');
  await expect(page.locator('#status')).toContainText('Running');
  const raw = firmware(); raw.name = 'synthetic-raw.bin'; raw.buffer = raw.buffer.subarray(256, 256 + 65536);
  await page.locator('#image').setInputFiles(raw); await page.locator('#validate-image').click();
  await expect(page.locator('#validation-summary')).toHaveText('FAIL · 0 passed · 1 failed · 6 not run');
  await expect(page.locator('#validation-format')).toBeVisible();
  await page.goto('/'); await page.locator('#browser-workbench summary').click();
  const panel = page.frameLocator('#emulator-frame'); await panel.locator('#image').setInputFiles(firmware());
  await page.evaluate(() => window.sq64Emulator.setLocked(true));
  await expect(panel.locator('#validate-image')).toBeDisabled();
  await page.evaluate(() => window.sq64Emulator.setLocked(false));
  await expect(panel.locator('#validate-image')).toBeEnabled();
});
