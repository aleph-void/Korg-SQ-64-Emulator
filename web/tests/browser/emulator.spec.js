import {test, expect} from './fixtures.js';
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
  await panel.locator('#update').click();
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
  // Interactive detents are recorded when their scheduled virtual edge runs.
  await expect.poll(() => page.evaluate(async () => (await window.sq64Emulator.request('recording')).some(e => e.type === 'encoder' && e.control === 'tempo' && e.delta === 1))).toBe(true);
});

test('firmware LED brightness is visible on named controls and distinguishes dim pads', async ({page}) => {
  await page.goto('/'); await page.locator('#browser-workbench summary').click();
  const panel = page.frameLocator('#emulator-frame');
  await panel.locator('#load-probe').click();
  await expect(panel.locator('#status')).toContainText('Running');
  await page.evaluate(async () => {
    const device = window.sq64Emulator; await device.request('pause');
    const state = structuredClone(await device.request('state'));
    device.worker.terminate(); // Freeze the probe before injecting a rendering-only snapshot.
    Object.assign(state.panel.leds, {tap: 255, play: 255, A1: 12, A2: 195, A3: 0});
    device.dispatchEvent(new CustomEvent('state', {detail: state}));
  });
  await expect(panel.locator('[data-control=tap]')).toHaveAttribute('data-led', '255');
  const styles = await panel.locator('[data-control]').evaluateAll(elements => Object.fromEntries(elements.map(e => [e.dataset.control, getComputedStyle(e).backgroundColor])));
  expect(styles.tap).toEqual(styles.play);
  expect(styles.tap).not.toEqual(styles.A3);
  expect(styles.A1).not.toEqual(styles.A2);
  expect(styles.A2).not.toEqual(styles.A3);
});

test('top-edge output lights show independent levels and clear on shutdown and reload', async ({page}) => {
  await page.goto('/'); await page.locator('#browser-workbench summary').click();
  const panel = page.frameLocator('#emulator-frame');
  await expect(panel.locator('[data-output]')).toHaveCount(17);
  await expect(panel.locator('[data-output].lit')).toHaveCount(0);
  await panel.locator('#load-probe').click(); await expect(panel.locator('#status')).toContainText('Running');
  await page.evaluate(async () => {
    const device = window.sq64Emulator; await device.request('pause');
    const state = structuredClone(await device.request('state')); device.worker.terminate();
    state.panel.outputs = {Amod: 32, Apitch: 180, Agate: 255, D1: 255, D8: 255};
    window.outputTestState = state; device.dispatchEvent(new CustomEvent('state', {detail: state}));
  });
  await expect(panel.locator('[data-output].lit')).toHaveCount(5);
  await expect(panel.getByRole('img', {name: 'Track A gate output: active'})).toBeVisible();
  for (const [name, level] of [['Amod', 32], ['Apitch', 180], ['Agate', 255], ['D8', 255], ['Bpitch', 0]]) await expect(panel.locator(`[data-output=${name}]`)).toHaveAttribute('data-led', String(level));
  const colors = await panel.locator('.output-lens').evaluateAll(elements => elements.slice(0, 3).map(e => getComputedStyle(e).backgroundColor));
  expect(new Set(colors).size).toBe(3);
  expect(await panel.locator('#outputs').evaluate(e => e.getBoundingClientRect().bottom <= document.querySelector('.instrument-top').getBoundingClientRect().top)).toBe(true);
  await page.evaluate(() => { window.outputTestState.report.board.poweredOff = true; window.sq64Emulator.dispatchEvent(new CustomEvent('state', {detail: window.outputTestState})); });
  await expect(panel.locator('[data-output].lit')).toHaveCount(0);
  await page.evaluate(() => window.sq64Emulator.dispatchEvent(new CustomEvent('state', {detail: {loaded: false}})));
  await expect(panel.locator('[data-output].lit')).toHaveCount(0);
});

test('parameter knobs normalize trackpad movement, support fine adjustment and release drags', async ({page}) => {
  await page.goto('/'); await page.locator('#browser-workbench summary').click();
  const panel = page.frameLocator('#emulator-frame');
  await panel.locator('#load-probe').click(); await expect(panel.locator('#status')).toContainText('Running');
  await page.evaluate(async () => {
    const device = window.sq64Emulator; await device.request('pause'); device.worker.terminate();
    window.knobRequests = []; device.request = async (action, data) => { if (action === 'event') window.knobRequests.push(data); return {}; };
  });
  const knob = panel.locator('[data-encoder=param1]');
  await knob.evaluate(e => {
    for (let i = 0; i < 40; i++) e.dispatchEvent(new WheelEvent('wheel', {deltaY: -1, deltaMode: 0, cancelable: true}));
    e.dispatchEvent(new WheelEvent('wheel', {deltaY: 0, deltaMode: 0, cancelable: true}));
    e.dispatchEvent(new WheelEvent('wheel', {deltaY: 160, deltaMode: 0, shiftKey: true, cancelable: true}));
  });
  await expect.poll(() => page.evaluate(() => window.knobRequests.map(e => e.delta))).toEqual([1, -1]);
  await knob.focus(); await page.keyboard.press('ArrowRight');
  const box = await knob.boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 24, {steps: 8}); await page.mouse.up();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 100);
  await expect.poll(() => page.evaluate(() => window.knobRequests.map(e => e.delta))).toEqual([1, -1, 1, 1, 1]);
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

test('update panel links the official firmware ZIP without any in-app download', async ({page}) => {
  await page.goto('/'); await page.locator('#browser-workbench summary').click();
  const panel = page.frameLocator('#emulator-frame');
  await expect(panel.locator('#boot-official')).toHaveCount(0);
  await page.getByRole('button', {name: 'Update firmware', exact: true}).click();
  await expect(page.locator('#official-firmware-zip')).toBeVisible();
  await expect(page.locator('#official-firmware-zip')).toHaveAttribute('href', 'https://cdn.korg.com/jp/support/download/files/765e1fc1c8b5e0fe446fefb7199dd6bf.zip');
  expect(await page.evaluate(() => window.sq64Emulator.loaded)).toBe(false);
});
