import { readFile } from 'node:fs/promises';
import { test, expect } from './fixtures.js';

const document = (actions, name = 'Browser script') => ({ format: 'sq64-ui-script', version: 1, name, actions });
const file = value => ({ name: 'actions.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) });
function firmware() {
  // Original power-probe.s: assert PB7, poll the power button, release PB7.
  const bytes = Buffer.alloc(65536);
  bytes.writeUInt32LE(0x20040000, 0); bytes.writeUInt32LE(0x200009, 4);
  bytes.set([0x06,0x48,0x80,0x21,0x01,0x60,0x06,0x4a,0x42,0xf2,0,3,
    0x11,0x68,0x19,0x42,0xfc,0xd1,0x4f,0xf4,0,1,1,0x60,0xfe,0xe7,0,0,
    0x18,4,2,0x40,0x10,8,2,0x40], 8);
  return { name: 'power-probe.bin', mimeType: 'application/octet-stream', buffer: bytes };
}
async function open(page, embedded = false) {
  await page.goto(embedded ? '/' : '/emulator/');
  if (embedded) await page.locator('#browser-workbench[open]').waitFor();
  const panel = embedded ? page.frameLocator('#emulator-frame') : page;
  await panel.locator('#ui-scripts summary').click();
  await expect(panel.locator('#script-new')).toBeEnabled();
  return panel;
}

for (const embedded of [false, true]) test(`${embedded ? 'embedded' : 'standalone'} playback updates buttons and encoders and keeps running until manual power-off`, async ({ page }) => {
  const panel = await open(page, embedded);
  await panel.locator('#image').setInputFiles(firmware());
  const script = document([
    { type: 'power-on', mode: 'normal' }, { type: 'button', control: 'A1', down: true },
    { type: 'encoder', control: 'tempo', delta: 2 }, { type: 'wait', ms: 2000 },
    { type: 'button', control: 'A1', down: false },
  ]);
  await panel.locator('#script-import').setInputFiles(file(script));
  await panel.locator('#script-run').click();
  await expect(panel.locator('[data-control=A1]')).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.locator('[data-encoder=tempo]')).toHaveAttribute('style', /24deg/);
  await expect(panel.locator('#image')).toBeDisabled();
  await expect(panel.locator('#reset')).toBeDisabled();
  await expect(panel.locator('#debug-enabled')).toBeDisabled();
  if (embedded) await expect(page.locator('#emulated')).toBeDisabled();
  await expect(panel.locator('#script-status')).toHaveText('Script complete · emulator keeps running');
  await expect(panel.locator('[data-control=A1]')).toHaveAttribute('aria-pressed', 'false');
  await expect(panel.locator('#status')).toContainText('Running');
  const ticks = await panel.locator('#ticks').textContent();
  await expect(panel.locator('#ticks')).not.toHaveText(ticks);
  await expect(panel.locator('#reset')).toBeEnabled();
  await panel.locator('#poweroff').click();
  await expect(panel.locator('#status')).toContainText('Powered off');
});

test('explicit script power-off waits for shutdown, and another script can power on again', async ({ page }) => {
  const panel = await open(page);
  await panel.locator('#image').setInputFiles(firmware());
  await panel.locator('#script-import').setInputFiles(file(document([
    { type: 'power-on', mode: 'normal' }, { type: 'wait', ms: 100 }, { type: 'power-off' },
  ])));
  await panel.locator('#script-run').click();
  await expect(panel.locator('#script-status')).toHaveText('Script complete · powered off');
  await expect(panel.locator('#status')).toContainText('Powered off');
  await panel.locator('#script-actions').fill(JSON.stringify([{ type: 'power-on', mode: 'update' }, { type: 'wait', ms: 100 }]));
  await panel.locator('#script-run').click();
  await expect(panel.locator('#script-status')).toHaveText('Script complete · emulator keeps running');
  await expect(panel.locator('[data-control=global]')).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.locator('[data-control=pattern]')).toHaveAttribute('aria-pressed', 'true');
});

test('Stop cancels a long press, releases the pad, and skips a later power-off', async ({ page }) => {
  const panel = await open(page);
  await panel.locator('#image').setInputFiles(firmware());
  await panel.locator('#script-import').setInputFiles(file(document([
    { type: 'press', control: 'A1', ms: 60000 }, { type: 'power-off' },
  ])));
  await panel.locator('#script-run').click();
  await expect(panel.locator('[data-control=A1]')).toHaveAttribute('aria-pressed', 'true');
  await panel.locator('#script-stop').click();
  await expect(panel.locator('#script-status')).toContainText('remaining actions cancelled');
  await expect(panel.locator('[data-control=A1]')).toHaveAttribute('aria-pressed', 'false');
  await expect(panel.locator('#status')).toContainText('Running');
  await expect(panel.locator('#script-run')).toBeEnabled();
});

test('scripts survive reload in IndexedDB, can be updated, exported, shared with the embedded editor, and deleted', async ({ page }) => {
  let panel = await open(page);
  const script = document([{ type: 'press', control: 'play', ms: 250 }], 'Saved sequence');
  await panel.locator('#script-import').setInputFiles(file(script));
  await panel.locator('#script-save').click();
  await expect(panel.locator('#script-status')).toContainText('Saved Saved sequence');
  const id = await panel.locator('#script-library').inputValue();
  expect(id).not.toBe('');
  panel = await open(page, true);
  await panel.locator('#script-library').selectOption(id);
  await expect(panel.locator('#script-name')).toHaveValue(script.name);
  expect(JSON.parse(await panel.locator('#script-actions').inputValue())).toEqual(script.actions);
  await panel.locator('#script-name').fill('Renamed sequence');
  await panel.locator('#script-save').click();
  await expect(panel.locator('#script-status')).toContainText('Saved Renamed sequence');
  await expect(panel.locator('#script-library option')).toHaveCount(2);
  const downloadPromise = page.waitForEvent('download');
  await panel.locator('#script-export').click();
  const download = await downloadPromise;
  expect(JSON.parse(await readFile(await download.path(), 'utf8'))).toEqual({ ...script, name: 'Renamed sequence' });
  await panel.locator('#script-import').setInputFiles(file({ ...script, version: 2 }));
  await expect(panel.locator('#script-status')).toContainText('Could not import');
  await expect(panel.locator('#script-name')).toHaveValue('Renamed sequence');
  await expect(panel.locator('#script-import')).toHaveValue('');
  await panel.locator('#script-delete').click();
  await expect(panel.locator('#script-status')).toContainText('Deleted browser copy');
  panel = await open(page);
  await expect(panel.locator('#script-library option')).toHaveCount(1);
});

test('example selection loads editable templates without executing or saving them', async ({ page }) => {
  const panel = await open(page);
  await expect(panel.locator('#script-examples option')).toHaveCount(9);
  for (const [id, name] of [['firmware-global-label', 'Regression exercise: GLOBAL channel label'],
    ['firmware-short-label-queue', 'Regression exercise: short display labels']]) {
    await panel.locator('#script-examples').selectOption(id);
    await panel.locator('#script-load-example').click();
    await expect(panel.locator('#script-name')).toHaveValue(name);
    await expect(panel.locator('#script-example-description')).toContainText('normal boot');
    await expect(panel.locator('#script-run')).toBeDisabled();
    await expect(panel.locator('#script-library option')).toHaveCount(1);
    const downloadPromise = page.waitForEvent('download');
    await panel.locator('#script-export').click();
    const downloaded = JSON.parse(await readFile(await (await downloadPromise).path(), 'utf8'));
    expect(downloaded.name).toBe(name);
    expect(downloaded.actions).toEqual(JSON.parse(await panel.locator('#script-actions').inputValue()));
  }
  await panel.locator('#script-examples').selectOption('encoders');
  await panel.locator('#script-load-example').click();
  await expect(panel.locator('#script-name')).toHaveValue('Turn the encoders');
  expect(JSON.parse(await panel.locator('#script-actions').inputValue())[0]).toEqual({ type: 'encoder', control: 'tempo', delta: 4 });
  await expect(panel.locator('#script-run')).toBeDisabled();
  await expect(panel.locator('#status')).toHaveText('Load your own firmware to begin.');
  await expect(panel.locator('#script-library option')).toHaveCount(1);
  await panel.locator('#script-action-type').selectOption('power-off');
  await panel.locator('#script-add').click();
  expect(JSON.parse(await panel.locator('#script-actions').inputValue()).at(-1)).toEqual({ type: 'power-off' });
  await panel.locator('#script-save').click();
  await expect(panel.locator('#script-status')).toContainText('Saved Turn the encoders');
});

test('unavailable IndexedDB does not prevent import, editing, or export', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'indexedDB', { value: undefined }));
  const panel = await open(page);
  await expect(panel.locator('#ui-scripts')).toContainText('IndexedDB is unavailable');
  await panel.locator('#script-import').setInputFiles(file(document([])));
  await panel.locator('#script-save').click();
  await expect(panel.locator('#script-status')).toContainText('Could not save');
  const download = page.waitForEvent('download');
  await panel.locator('#script-export').click();
  expect((await download).suggestedFilename()).toBe('Browser-script.json');
});

test('invalid editor data never starts the instance or takes the script lock', async ({ page }) => {
  const panel = await open(page, true);
  await panel.locator('#image').setInputFiles(firmware());
  await panel.locator('#script-actions').fill(JSON.stringify([{ type: 'power-on', mode: 'normal' }, { type: 'button', control: 'A99', down: true }]));
  await panel.locator('#script-run').click();
  await expect(panel.locator('#script-status')).toContainText('Action 2');
  await expect(panel.locator('#status')).toContainText('Firmware loaded');
  await expect(page.locator('#emulated')).toBeEnabled();
});

for (const id of ['firmware-global-label', 'firmware-short-label-queue']) {
  test(`${id} runs after the virtual device has powered off`, async ({ page }) => {
    test.slow(); // The example's real wait actions add up to ~11 s before CI overhead.
    const panel = await open(page);
    await panel.locator('#image').setInputFiles(firmware());
    await panel.locator('#script-import').setInputFiles(file(document([
      { type: 'power-on', mode: 'normal' }, { type: 'wait', ms: 100 }, { type: 'power-off' },
    ])));
    await panel.locator('#script-run').click();
    await expect(panel.locator('#script-status')).toHaveText('Script complete · powered off');
    await expect(panel.locator('#status')).toContainText('Powered off');
    await panel.locator('#script-examples').selectOption(id);
    await panel.locator('#script-load-example').click();
    const actions = JSON.parse(await panel.locator('#script-actions').inputValue());
    expect(actions.slice(0, 2)).toEqual([{ type: 'power-on', mode: 'normal' }, { type: 'wait', ms: 60000 }]);
    // The synthetic power probe boots immediately; retain the real action order.
    actions[1].ms = 100;
    await panel.locator('#script-actions').fill(JSON.stringify(actions));
    await panel.locator('#script-run').click();
    await expect(panel.locator('#script-status')).toHaveText('Script complete · emulator keeps running', { timeout: 60000 });
    await expect(panel.locator('#status')).toContainText('Running');
  });
}
