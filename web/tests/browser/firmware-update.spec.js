import { test, expect } from './fixtures.js';
import { syntheticVsb } from '../fixtures.js';

const candidate = () => ({ name: 'second-image.vsb', mimeType: 'application/octet-stream', buffer: Buffer.from(syntheticVsb()) });

test('standalone emulator accepts a separate update image and submits it to the executing ARM updater', async ({ page }) => {
  test.setTimeout(90000);
  await page.addInitScript(() => { navigator.requestMIDIAccess = () => { throw Error('No physical MIDI'); }; });
  await page.goto('/emulator/');
  await page.locator('#load-probe').click();
  await expect(page.locator('#status')).toContainText('Running');
  await page.locator('#firmware-update summary').click();
  await page.locator('#update-image').setInputFiles(candidate());
  await expect(page.locator('#update-file-info')).toContainText('second-image.vsb');
  await expect(page.locator('#send-update')).toBeDisabled();
  await page.locator('#update').click();
  await page.locator('#send-update').click();
  await expect(page.locator('#image')).toBeDisabled();
  await expect(page.locator('#reset')).toBeDisabled();
  await expect(page.locator('#update-image')).toBeDisabled();
  await expect(page.locator('#update-status')).toContainText('224 packets acknowledged', { timeout: 60000 });
  await expect(page.locator('#image-status')).toContainText('Original integration probe');
  await expect(page.locator('#status')).toContainText('Running');
  await expect(page.locator('#reset')).toBeEnabled();

  // A rejected selection must not leave the previous update ready to send.
  await page.locator('#update-image').setInputFiles({ name: 'bad.vsb', mimeType: 'application/octet-stream', buffer: Buffer.from('bad') });
  await expect(page.locator('#update-file-info')).toContainText('229,632-byte');
  await expect(page.locator('#send-update')).toBeDisabled();
  await expect(page.locator('#reset')).toBeEnabled();
  await page.locator('#update-image').setInputFiles(candidate());
  await expect(page.locator('#send-update')).toBeEnabled();
});

test('embedded update script stages the second image and locks the outer updater until it completes', async ({ page }) => {
  test.setTimeout(90000);
  await page.goto('/'); await page.locator('#browser-workbench[open]').waitFor();
  const panel = page.frameLocator('#emulator-frame');
  await panel.locator('#load-probe').click();
  await expect(panel.locator('#status')).toContainText('Running');
  await panel.locator('#firmware-update summary').click();
  await panel.locator('#update-image').setInputFiles(candidate());
  await panel.locator('#ui-scripts summary').click();
  await panel.locator('#script-actions').fill(JSON.stringify([{ type: 'power-on', mode: 'update' }]));
  await panel.locator('#script-action-type').selectOption('firmware-update');
  await panel.locator('#script-add').click();
  expect(JSON.parse(await panel.locator('#script-actions').inputValue()).at(-1)).toEqual({ type: 'firmware-update', allowOlder: false });
  await panel.locator('#script-run').click();
  await expect(page.locator('#emulated')).toBeDisabled();
  await expect(panel.locator('#update-image')).toBeDisabled();
  await expect(panel.locator('#script-status')).toHaveText('Script complete · emulator keeps running', { timeout: 60000 });
  await expect(panel.locator('#update-status')).toContainText('224 packets acknowledged');
  const actual = await page.evaluate(async () => Array.from((await window.sq64Emulator.request('storage')).spi.slice(0x40000, 0x78000)));
  expect(Buffer.from(actual)).toEqual(Buffer.from(syntheticVsb().slice(256)));
  await expect(page.locator('#emulated')).toBeEnabled();
  await expect(panel.locator('#image-status')).toContainText('Original integration probe');
});

test('missing update file fails before script startup; stopping during USB startup cancels the transfer', async ({ page }) => {
  await page.goto('/emulator/');
  // Original infinite-loop firmware does not configure USB.
  const bytes = Buffer.alloc(65536); bytes.writeUInt32LE(0x20040000, 0); bytes.writeUInt32LE(0x200009, 4); bytes.set([0xfe, 0xe7], 8);
  await page.locator('#image').setInputFiles({ name: 'loop.bin', mimeType: 'application/octet-stream', buffer: bytes });
  await page.locator('#ui-scripts summary').click();
  await page.locator('#script-actions').fill(JSON.stringify([
    { type: 'power-on', mode: 'update' }, { type: 'firmware-update' }, { type: 'button', control: 'play', down: true },
  ]));
  await page.locator('#script-run').click();
  await expect(page.locator('#script-status')).toContainText('Select an update VSB');
  await expect(page.locator('#status')).toContainText('Firmware loaded');
  await page.locator('#firmware-update summary').click();
  await page.locator('#update-image').setInputFiles(candidate());
  await page.locator('#script-run').click();
  await expect(page.locator('#update-status')).toContainText('Waiting for the emulator updater');
  await page.locator('#script-stop').click();
  await expect(page.locator('#script-status')).toContainText('remaining actions cancelled');
  await expect(page.locator('#update-status')).toContainText('Transfer stopped');
  await expect(page.locator('[data-control=play]')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#reset')).toBeEnabled();
});

test('manual embedded transfer locks the outer updater and Stop releases both workbenches', async ({ page }) => {
  await page.goto('/'); await page.locator('#browser-workbench[open]').waitFor();
  const panel = page.frameLocator('#emulator-frame');
  const bytes = Buffer.alloc(65536); bytes.writeUInt32LE(0x20040000, 0); bytes.writeUInt32LE(0x200009, 4); bytes.set([0xfe, 0xe7], 8);
  await panel.locator('#image').setInputFiles({ name: 'loop.bin', mimeType: 'application/octet-stream', buffer: bytes });
  await panel.locator('#update').click();
  await panel.locator('#firmware-update summary').click();
  await panel.locator('#update-image').setInputFiles(candidate());
  await panel.locator('#send-update').click();
  await expect(panel.locator('#update-status')).toContainText('Waiting for the emulator updater');
  await expect(page.locator('#emulated')).toBeDisabled();
  await expect(page.locator('#connect')).toBeDisabled();
  await expect(panel.locator('#reset')).toBeDisabled();
  await panel.locator('#ui-scripts summary').click();
  await expect(panel.locator('#script-run')).toBeDisabled();
  await panel.locator('#stop-update').click();
  await expect(panel.locator('#update-status')).toContainText('Transfer stopped');
  await expect(page.locator('#emulated')).toBeEnabled();
  await expect(panel.locator('#reset')).toBeEnabled();
  await expect(panel.locator('#script-run')).toBeEnabled();
});
