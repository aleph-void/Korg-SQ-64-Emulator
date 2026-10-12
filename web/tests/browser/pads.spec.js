import {test, expect} from './fixtures.js';
import {readFile} from 'node:fs/promises';

async function setup(page, native) {
  const events = [];
  if (native) {
    // Exercise the Python workbench's actual UI with a deterministic API stub.
    const state = {
      loaded: true, running: false, mode: 'normal', midi: 'Disabled',
      report: {pc: 0x200008, interrupts: {delivered: 0}, board: {ticks: 0, approximations: [], midiOut: []}},
      panel: {buttons: {}, leds: {}, encoders: {}, display: '00'.repeat(8192), displayFrames: 0},
    };
    await page.route('**/native-panel/**', async route => {
      const path = new URL(route.request().url()).pathname.slice('/native-panel/'.length) || 'index.html';
      const contentType = path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.html') ? 'text/html' : undefined;
      await route.fulfill({body: await readFile(new URL(`../../../sq64_emulator/ui/${path}`, import.meta.url)), contentType});
    });
    await page.route('**/api/**', async route => {
      const action = new URL(route.request().url()).pathname.split('/').at(-1);
      if (action === 'event') {
        const event = route.request().postDataJSON(); events.push(event);
        state.panel.buttons[event.control] = event.down;
      }
      if (action === 'reset') state.panel.buttons = {};
      await route.fulfill({json: action === 'session' ? {token: 'test'} : state});
    });
    await page.goto('/native-panel/');
    await expect(page.locator('[data-control=A1]')).toBeEnabled();
    return {panel: page, events: async () => [...events]};
  }
  await page.goto('/'); await page.locator('#browser-workbench[open]').waitFor();
  const panel = page.frameLocator('#emulator-frame');
  const buffer = Buffer.alloc(65536);
  buffer.writeUInt32LE(0x20040000, 0); buffer.writeUInt32LE(0x200009, 4); buffer.set([0xfe, 0xe7], 8);
  await panel.locator('#image').setInputFiles({name: 'original-loop.bin', mimeType: 'application/octet-stream', buffer});
  await expect(panel.locator('[data-control=A1]')).toBeEnabled();
  await page.evaluate(() => {
    const device = window.sq64Emulator, request = device.request.bind(device);
    window.buttonRequests = [];
    device.request = (action, data) => {
      if (action === 'event') { window.buttonRequests.push(data); return Promise.resolve({}); }
      return request(action, data);
    };
  });
  return {panel, events: () => page.evaluate(() => window.buttonRequests)};
}

for (const native of [false, true]) {
  test.describe(native ? 'Python workbench panel' : 'browser emulator panel', () => {
    test('all 85 controls latch independently, release on double-click, and clear on reset', async ({page}) => {
      test.setTimeout(60000);
      const {panel, events} = await setup(page, native);
      const controls = await panel.locator('[data-control]').evaluateAll(elements => elements.map(e => e.dataset.control));
      expect(controls).toHaveLength(85);
      for (const control of controls) {
        const button = panel.locator(`[data-control=${control}]`);
        await button.dblclick();
        await expect(button).toHaveAttribute('data-latched', 'true');
        await expect(button).toHaveAttribute('aria-pressed', 'true');
        await button.click(); // A single click cannot release a latch.
        await expect(button).toHaveAttribute('aria-pressed', 'true');
      }
      await expect.poll(async () => Object.keys(Object.fromEntries((await events()).filter(e => e.down).map(e => [e.control, true]))).length).toBe(85);
      for (const control of controls) {
        const button = panel.locator(`[data-control=${control}]`);
        await button.dblclick();
        await expect(button).toHaveAttribute('data-latched', 'false');
        await expect(button).toHaveAttribute('aria-pressed', 'false');
      }
      await expect.poll(async () => Object.values(Object.fromEntries((await events()).map(e => [e.control, e.down]))).every(down => !down)).toBe(true);
      for (const control of ['A1', 'D16', 'trackB', 'gate', 'shift']) await panel.locator(`[data-control=${control}]`).dblclick();
      await panel.locator('#reset').click();
      await expect(panel.locator('[data-latched=true]')).toHaveCount(0);
      await expect(panel.locator('[data-control][aria-pressed=true]')).toHaveCount(0);
    });

    test('ordinary taps and holds still work alongside keyboard and Shift-click latching', async ({page}) => {
      const {panel, events} = await setup(page, native);
      for (const control of ['A1', 'D16', 'trackB', 'gate', 'play']) {
        const button = panel.locator(`[data-control=${control}]`);
        await button.click();
        await expect.poll(async () => (await events()).filter(e => e.control === control).map(e => e.down)).toEqual([true, false]);
        await button.scrollIntoViewIfNeeded();
        const box = await button.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
        await expect(button).toHaveAttribute('aria-pressed', 'true');
        await page.mouse.move(0, 0); await page.mouse.up();
        await expect(button).toHaveAttribute('aria-pressed', 'false');
        await button.focus(); await page.keyboard.down('Space');
        await expect(button).toHaveAttribute('aria-pressed', 'true');
        await page.keyboard.down('Space'); // Auto-repeat must not latch.
        await expect(button).toHaveAttribute('data-latched', 'false');
        await page.keyboard.up('Space');
        await expect(button).toHaveAttribute('aria-pressed', 'false');
        await page.keyboard.press('Space');
        await expect(button).toHaveAttribute('data-latched', 'true');
        await expect(button).toHaveAttribute('aria-pressed', 'true');
        await page.keyboard.press('Enter');
        await expect(button).toHaveAttribute('aria-pressed', 'true');
        await page.keyboard.press('Enter');
        await expect(button).toHaveAttribute('data-latched', 'false');
        await expect(button).toHaveAttribute('aria-pressed', 'false');
        await button.click({modifiers: ['Shift']});
        await expect(button).toHaveAttribute('data-latched', 'true');
        await button.dblclick();
        await expect(button).toHaveAttribute('aria-pressed', 'false');
      }
    });

    test('each control has its own latch tooltip', async ({page}) => {
      const {panel} = await setup(page, native);
      await page.clock.install();
      for (const control of ['A1', 'gate', 'shift']) {
        const button = panel.locator(`[data-control=${control}]`);
        for (let i = 0; i < 4; i++) await button.click();
        await expect(button).toHaveAttribute('aria-describedby', `${control}-latch-tip`);
        await expect(button.getByRole('tooltip')).toHaveText(`Double-click ${control === 'A1' ? 'Pad A1' : control.toUpperCase()} to toggle its latched state.`);
      }
      await expect(panel.getByRole('tooltip')).toHaveCount(3);
      await panel.locator('[data-control=A1]').focus(); await page.keyboard.press('Escape');
      await expect(panel.getByRole('tooltip')).toHaveCount(2);
      await page.clock.fastForward(6001);
      await expect(panel.getByRole('tooltip')).toHaveCount(0);
    });
  });
}
