import {test, expect} from './fixtures.js';

async function setup(page) {
  await page.goto('/'); await page.locator('#browser-workbench').waitFor();
  const panel = page.frameLocator('#emulator-frame');
  const buffer = Buffer.alloc(65536);
  buffer.writeUInt32LE(0x20040000, 0); buffer.writeUInt32LE(0x200009, 4); buffer.set([0xfe, 0xe7], 8);
  await panel.locator('#image').setInputFiles({name: 'original-loop.bin', mimeType: 'application/octet-stream', buffer});
  await page.evaluate(() => {
    const device = window.sq64Emulator, request = device.request.bind(device);
    window.buttonRequests = [];
    device.request = (action, data) => {
      if (action === 'event') { window.buttonRequests.push(data); return Promise.resolve({}); }
      return request(action, data);
    };
  });
  return {panel, shift: panel.locator('[data-control=shift]')};
}

test('SHIFT latches only on double-click and single clicks or keys cannot release the latch', async ({page}) => {
  const {panel, shift} = await setup(page);
  await shift.click();
  await expect(shift).toHaveAttribute('data-latched', 'false');
  expect(await page.evaluate(() => window.buttonRequests)).toEqual([]);
  await shift.click({modifiers: ['Shift']});
  await expect(shift).toHaveAttribute('data-latched', 'false');
  await shift.dblclick();
  await expect(shift).toHaveAttribute('data-latched', 'true');
  await expect(shift).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.buttonRequests.map(event => event.down))).toEqual([true]);
  await page.evaluate(() => { window.buttonRequests = []; });
  await shift.click(); await shift.focus(); await page.keyboard.press('Space');
  expect(await page.evaluate(() => window.buttonRequests)).toEqual([]);
  await shift.dblclick();
  await expect(shift).toHaveAttribute('data-latched', 'false');
  expect(await page.evaluate(() => window.buttonRequests.map(event => event.down))).toEqual([false]);
  await shift.dblclick(); await panel.locator('#reset').click();
  await expect(shift).toHaveAttribute('data-latched', 'false');
  await shift.focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
  await expect(shift).toHaveAttribute('data-latched', 'true');
});

test('four SHIFT presses in a rolling two-second window show a temporary tooltip', async ({page}) => {
  const {panel, shift} = await setup(page);
  await page.clock.install();
  for (let i = 0; i < 3; i++) { await shift.click(); await page.clock.runFor(200); }
  await expect(panel.getByRole('tooltip')).toHaveCount(0);
  await shift.click();
  await expect(panel.getByRole('tooltip')).toHaveText('Double-click SHIFT to toggle its latched state.');
  await expect(shift).toHaveAttribute('aria-describedby', 'shift-latch-tip');
  await page.clock.fastForward(6001);
  await expect(panel.getByRole('tooltip')).toHaveCount(0);
  for (let i = 0; i < 3; i++) await shift.click();
  await page.clock.fastForward(2001);
  await shift.click();
  await expect(panel.getByRole('tooltip')).toHaveCount(0);
});

test('SHIFT transitions never convert already-lit pads into input while playing', async ({page}) => {
  const {panel, shift} = await setup(page);
  await expect(shift).toBeEnabled();
  await page.evaluate(async () => {
    const device = window.sq64Emulator;
    const state = await device.request('state');
    state.running = true;
    for (const name of ['A1', 'A4', 'B2', 'C3', 'D1', 'D8']) state.panel.leds[name] = 255;
    device.worker.terminate(); // Freeze a firmware snapshot with lit, unpressed pads.
    device.dispatchEvent(new CustomEvent('state', {detail: state}));
  });
  await expect(panel.locator('.pad.lit')).toHaveCount(6);
  await shift.dblclick(); await shift.dblclick();
  expect(await page.evaluate(() => window.buttonRequests)).toEqual([
    {type: 'button', control: 'shift', down: true},
    {type: 'button', control: 'shift', down: false},
  ]);
  await expect(panel.locator('.pad[aria-pressed=true]')).toHaveCount(0);
  await expect(panel.locator('[data-output].lit')).toHaveCount(0);
});
