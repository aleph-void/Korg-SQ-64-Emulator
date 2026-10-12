import {test, expect} from './fixtures.js';

function firmware() {
  const bytes = Buffer.alloc(65536);
  bytes.writeUInt32LE(0x20040000, 0); bytes.writeUInt32LE(0x200009, 4);
  bytes.set([1, 0x30, 0xfd, 0xe7], 8); // Original ADDS/B loop.
  return {name: 'original-loop.bin', mimeType: 'application/octet-stream', buffer: bytes};
}
const badFile = {name: 'invalid.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('invalid')};

for (const embedded of [true, false]) {
  test(`${embedded ? 'embedded' : 'standalone'} file selection enables Power on and keeps load failures visible`, async ({page}) => {
    await page.goto(embedded ? '/' : '/emulator/');
    if (embedded) await page.locator('#browser-workbench summary').click();
    const panel = embedded ? page.frameLocator('#emulator-frame') : page;
    await expect(panel.locator('#reset')).toBeDisabled();
    await panel.locator('#image').setInputFiles(badFile);
    await expect(panel.locator('#status')).not.toHaveText('Loading firmware…');
    await expect(panel.locator('#reset')).toBeDisabled();
    await expect(panel.locator('#image')).toHaveValue('');
    await expect(panel.locator('#image-status')).toBeVisible();
    await panel.locator('#image').setInputFiles(firmware());
    await expect(panel.locator('#status')).toHaveText('Firmware loaded · press Power on to start');
    await expect(panel.locator('#image-status')).toHaveText('Loaded: original-loop.bin');
    await expect(panel.locator('#image')).toHaveValue(/original-loop\.bin$/);
    for (const id of ['reset', 'run', 'version', 'update', 'debug-enabled', 'validate-image']) await expect(panel.locator(`#${id}`)).toBeEnabled();
    await panel.locator('#reset').click();
    await expect(panel.locator('#status')).toContainText('Running');
    await panel.locator('#image').setInputFiles(badFile);
    const status = panel.locator('#status');
    await expect(status).not.toContainText('Running');
    await expect(status).not.toHaveText('Loading firmware…');
    const failure = await status.textContent();
    await expect(panel.locator('#image-status')).toHaveText(failure);
    // Periodic firmware snapshots must not overwrite a failed replacement's error.
    const ticks = await panel.locator('#ticks').textContent();
    await expect(panel.locator('#ticks')).not.toHaveText(ticks);
    await expect(status).toHaveText(failure);
    await expect(panel.locator('#reset')).toBeEnabled();
    await panel.locator('#image').setInputFiles(firmware());
    await expect(status).toHaveText('Firmware loaded · press Power on to start');
    await expect(panel.locator('#image')).toHaveValue(/original-loop\.bin$/);
    await expect(panel.locator('#reset')).toBeEnabled();
  });
}

test('encoder turns cross noon in both directions and discard partial gestures on reset and lock', async ({page}) => {
  await page.goto('/'); await page.locator('#browser-workbench summary').click();
  const panel = page.frameLocator('#emulator-frame');
  await panel.locator('#image').setInputFiles(firmware());
  await expect(panel.locator('[data-encoder=param1]')).toBeEnabled();
  await page.evaluate(() => {
    const device = window.sq64Emulator, request = device.request.bind(device);
    window.encoderRequests = [];
    device.request = (action, data) => {
      if (action === 'event') { window.encoderRequests.push(data); return Promise.resolve({}); }
      return request(action, data);
    };
  });
  const knob = panel.locator('[data-encoder=param1]');
  const wheel = deltaY => knob.evaluate((element, delta) => element.dispatchEvent(new WheelEvent('wheel', {deltaY: delta, cancelable: true})), deltaY);
  await wheel(600); await wheel(-600); // 15 detents out and back; no angular wrap changes direction.
  await expect.poll(() => page.evaluate(() => window.encoderRequests.map(event => event.delta))).toEqual([-15, 15]);
  await wheel(-39); // Partial wheel step must not survive a machine reset.
  await panel.locator('#reset').click(); await expect(panel.locator('#status')).toContainText('Running');
  await wheel(-1);
  await page.evaluate(() => window.sq64Emulator.setLocked(true));
  await expect(knob).toBeDisabled();
  await page.evaluate(() => window.sq64Emulator.setLocked(false));
  await expect(knob).toBeEnabled();
  await wheel(-39);
  expect(await page.evaluate(() => window.encoderRequests.map(event => event.delta))).toEqual([-15, 15]);
  await wheel(-1);
  await knob.focus(); await wheel(39); await page.keyboard.press('ArrowLeft'); await wheel(1);
  expect(await page.evaluate(() => window.encoderRequests.map(event => event.delta))).toEqual([-15, 15, 1, -1]);
  await expect(knob).toHaveAttribute('aria-describedby', 'encoder-help');
});

test('updater keeps acknowledgements and selected files when switching Vue tabs, and clears removed files', async ({page}) => {
  await page.goto('/'); await page.locator('#demo').click();
  await page.locator('[data-tab=update]').click(); await page.locator('#ready').check();
  await page.locator('[data-tab=backup]').click(); await page.locator('[data-tab=update]').click();
  await expect(page.locator('#ready')).toBeChecked();
  await page.locator('#firmware').setInputFiles(badFile);
  await expect(page.locator('#file-info')).toContainText('229,632-byte');
  await page.locator('#firmware').setInputFiles([]);
  await expect(page.locator('#file-info')).toHaveText('No firmware selected');
  await expect(page.locator('#update-start')).toBeDisabled();
});

test('parameter knob out-and-back drags and wheel turns do not drift on reversal', async ({page}) => {
  await page.goto('/'); await page.locator('#browser-workbench summary').click();
  const panel = page.frameLocator('#emulator-frame');
  await panel.locator('#image').setInputFiles(firmware());
  await page.evaluate(() => {
    const device = window.sq64Emulator, request = device.request.bind(device);
    window.encoderRequests = [];
    device.request = (action, data) => {
      if (action === 'event') { window.encoderRequests.push(data); return Promise.resolve({}); }
      return request(action, data);
    };
  });
  for (const name of ['param1', 'param2', 'param3', 'param4']) {
    const knob = panel.locator(`[data-encoder=${name}]`);
    await expect(knob).toBeEnabled(); await knob.scrollIntoViewIfNeeded();
    const box = await knob.boundingBox();
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    let position = y;
    for (const distance of [15, -12, 9, -12]) {
      position -= distance;
      await page.mouse.move(x, position);
    }
    await page.mouse.up();
    const drag = await page.evaluate(name => window.encoderRequests.filter(row => row.control === name).map(row => row.delta), name);
    expect(drag.length).toBeGreaterThan(0); expect(drag.reduce((sum, delta) => sum + delta, 0)).toBe(0);
    await page.evaluate(() => { window.encoderRequests = []; });
    await knob.evaluate(element => {
      for (const deltaY of [-50, 40, -30, 40]) element.dispatchEvent(new WheelEvent('wheel', {deltaY, cancelable: true}));
    });
    const wheel = await page.evaluate(() => window.encoderRequests.map(row => row.delta));
    expect(wheel.length).toBeGreaterThan(0); expect(wheel.reduce((sum, delta) => sum + delta, 0)).toBe(0);
    await page.evaluate(() => { window.encoderRequests = []; });
  }
});
