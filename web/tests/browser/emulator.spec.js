import {test, expect} from '@playwright/test';
import {syntheticVsb} from '../fixtures.js';

test('independently authored ARM probe backs up and stages an update without Web MIDI', async ({page}) => {
  test.setTimeout(90000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { navigator.requestMIDIAccess = () => { throw Error('Web MIDI must not be requested for the emulator'); }; });
  await page.goto('/'); await page.locator('#browser-workbench summary').click();
  const panel = page.frameLocator('#emulator-frame');
  await panel.getByRole('button', {name: 'Load original integration probe'}).click();
  await expect(panel.locator('#status')).toContainText('Running');
  await page.locator('#emulated').click();
  await expect(page.locator('#connection-state')).toHaveText('Browser emulator connected');
  await page.locator('#scope').selectOption('current');
  const download = page.waitForEvent('download'); await page.locator('#backup-start').click();
  const file = await (await download).path(); await expect(page.locator('#status')).toHaveText('Backup saved');
  await page.getByRole('button', {name: 'Restore', exact: true}).click();
  await page.locator('#backup-file').setInputFiles(file); await page.locator('#restore-ready').check(); await page.locator('#restore-start').click();
  await expect(page.locator('#status')).toHaveText('Restore acknowledged by device');
  await page.getByRole('button', {name: 'Update firmware'}).click();
  const data = syntheticVsb();
  await page.locator('#firmware').setInputFiles({name: 'synthetic-never-flash.vsb', mimeType: 'application/octet-stream', buffer: Buffer.from(data)});
  await page.locator('#ready').check(); await page.locator('#update-start').click();
  await expect(panel.locator('#reset')).toBeDisabled();
  await expect(page.locator('#completion')).toBeVisible({timeout: 60000});
  const actual = await page.evaluate(async () => Array.from((await window.sq64Emulator.request('storage')).spi.slice(0x40000, 0x78000)));
  expect(Buffer.from(actual)).toEqual(Buffer.from(data.slice(256)));
  expect(errors).toEqual([]);
});

test('control surface records inputs and requests startup chords (UI state only)', async ({page}) => {
  await page.goto('/'); await page.locator('#browser-workbench summary').click();
  const panel = page.frameLocator('#emulator-frame');
  await panel.locator('#load-probe').click(); await expect(panel.locator('#status')).toContainText('Running');
  await panel.locator('#version').click();
  await expect(panel.locator('[data-control=global]')).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.locator('[data-control=pattern]')).toHaveAttribute('aria-pressed', 'false');
  await panel.locator('#update').click();
  await expect(panel.locator('[data-control=pattern]')).toHaveAttribute('aria-pressed', 'true');
  await panel.locator('#release').click();
  await expect(panel.locator('[data-control=global]')).toHaveAttribute('aria-pressed', 'false');
  await expect(panel.locator('[data-control]')).toHaveCount(85);
  await expect(panel.locator('[data-encoder]')).toHaveCount(6);
  await panel.locator('[data-encoder=tempo]').focus(); await page.keyboard.press('ArrowRight');
  const recording = await page.evaluate(() => window.sq64Emulator.request('recording'));
  expect(recording.some(e => e.type === 'encoder' && e.control === 'tempo' && e.delta === 1)).toBe(true);
});


test('power button lets ARM firmware release power, disconnects MIDI, and restarts', async ({page}) => {
  // Independently authored power-probe.s: assert PB7, poll PC13, release PB7.
  const bytes = Buffer.alloc(65536);
  bytes.writeUInt32LE(0x20040000, 0); bytes.writeUInt32LE(0x200009, 4);
  bytes.set([0x06,0x48,0x80,0x21,0x01,0x60,0x06,0x4a,0x42,0xf2,0,3,
    0x11,0x68,0x19,0x42,0xfc,0xd1,0x4f,0xf4,0,1,1,0x60,0xfe,0xe7,0,0,
    0x18,4,2,0x40,0x10,8,2,0x40], 8);
  await page.goto('/'); await page.locator('#browser-workbench summary').click();
  const panel = page.frameLocator('#emulator-frame');
  await panel.locator('#image').setInputFiles({name:'original-power-probe.bin',mimeType:'application/octet-stream',buffer:bytes});
  await expect(panel.locator('#run')).toBeEnabled(); await panel.locator('#run').click();
  await expect(panel.locator('#status')).toContainText('Running');
  await panel.locator('#poweroff').click();
  await expect(panel.locator('#status')).toContainText('Powered off');
  expect(await page.evaluate(() => window.sq64Emulator.output.state)).toBe('disconnected');
  await expect(panel.locator('#run')).toBeDisabled(); await panel.locator('#reset').click();
  await expect(panel.locator('#status')).toContainText('Running');
  expect(await page.evaluate(() => window.sq64Emulator.output.state)).toBe('connected');
});
