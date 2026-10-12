import {test, expect} from '@playwright/test';

const firmware = () => {
  const bytes = Buffer.alloc(65536);
  bytes.writeUInt32LE(0x20040000, 0); bytes.writeUInt32LE(0x200009, 4);
  bytes.set([1, 0x30, 0xfd, 0xe7], 8); // ADDS R0, #1; B back to ADDS.
  return {name: 'original-debug-probe.bin', mimeType: 'application/octet-stream', buffer: bytes};
};

test('optional debugger stops, steps, inspects, exports and resets without MIDI resuming it', async ({page}) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/'); await page.locator('#browser-workbench summary').click();
  const panel = page.frameLocator('#emulator-frame');
  await panel.getByText('Developer debugging', {exact: true}).click();
  await expect(panel.locator('#debug-enabled')).toBeDisabled();
  await panel.locator('#image').setInputFiles(firmware());
  await expect(panel.locator('#debug-enabled')).toBeEnabled();
  await expect(panel.locator('#debug-tools')).toBeHidden();
  await panel.locator('#debug-enabled').check();
  await expect(panel.locator('#debug-tools')).toBeVisible();
  await panel.locator('#debug-breakpoints').fill('0x00200009');
  await panel.locator('#debug-trace-limit').fill('2');
  await panel.locator('#debug-apply').click();
  await expect(panel.locator('#debug-points')).toHaveText('0x00200008');
  await expect(panel.locator('#debug-trace-limit')).toHaveValue('2');
  await panel.locator('#run').click();
  await expect(panel.locator('#status')).toContainText('Breakpoint at 0x00200008');
  await expect(panel.locator('#ticks')).toHaveText('0');
  await panel.locator('#debug-step').click();
  await expect(panel.locator('#pc')).toHaveText('0x0020000a');
  await expect(panel.locator('#debug-registers')).toContainText('R0        0x00000001');
  await panel.locator('#run').click();
  await expect(panel.locator('#status')).toContainText('Breakpoint at');
  await expect(panel.locator('#ticks')).toHaveText('2');
  await panel.locator('#debug-address').fill('0x00200008');
  await panel.locator('#debug-length').fill('4'); await panel.locator('#debug-read').click();
  await expect(panel.locator('#debug-memory')).toContainText('01 30 fd e7');
  const download = page.waitForEvent('download'); await panel.locator('#debug-save').click();
  const stream = await (await download).createReadStream(), chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const report = JSON.parse(Buffer.concat(chunks).toString());
  expect(report.debug.stoppedAt).toBe(0x200008); expect(report.debug.trace).toHaveLength(2); expect(report.imageSha256).toHaveLength(64);
  const midi = await page.evaluate(() => window.sq64Emulator.request('midi', [0x90, 60, 100]));
  expect(midi.running).toBe(false); expect(midi.report.board.ticks).toBe(2);
  await panel.locator('#reset').click();
  await expect(panel.locator('#ticks')).toHaveText('0');
  await expect(panel.locator('#debug-stop')).toHaveText('Paused');
  await expect(panel.locator('#debug-points')).toHaveText('0x00200008');
  await expect(panel.locator('#debug-memory')).toHaveText('Read memory while paused.');
  await panel.locator('#debug-enabled').uncheck();
  await expect(panel.locator('#debug-tools')).toBeHidden();
  await panel.locator('#run').click();
  await expect(panel.locator('#status')).toContainText('Running');
  expect(errors).toEqual([]);
});

test('debug controls reject invalid input, respect transaction locks and clear on image replacement', async ({page}) => {
  await page.goto('/'); await page.locator('#browser-workbench summary').click();
  const panel = page.frameLocator('#emulator-frame');
  await panel.locator('#image').setInputFiles(firmware());
  await panel.getByText('Developer debugging', {exact: true}).click();
  await panel.locator('#debug-enabled').check();
  await panel.locator('#debug-breakpoints').fill('invalid'); await panel.locator('#debug-apply').click();
  await expect(panel.locator('#debug-message')).toContainText('32-bit address');
  await panel.locator('#debug-address').fill('0x40004404'); await panel.locator('#debug-read').click();
  await expect(panel.locator('#debug-message')).toContainText('code and RAM');
  await page.evaluate(() => window.sq64Emulator.setLocked(true));
  for (const id of ['debug-enabled', 'debug-step', 'debug-apply', 'debug-read', 'debug-save']) await expect(panel.locator(`#${id}`)).toBeDisabled();
  await page.evaluate(() => window.sq64Emulator.setLocked(false));
  await expect(panel.locator('#debug-enabled')).toBeEnabled();
  await panel.locator('#image').setInputFiles(firmware());
  await expect(panel.locator('#debug-enabled')).not.toBeChecked();
  await expect(panel.locator('#debug-tools')).toBeHidden();
});
