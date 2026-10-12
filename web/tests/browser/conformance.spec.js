import {test, expect} from './fixtures.js';
import {syntheticVsb} from '../fixtures.js';

// markCriticalTest patches the worker catalog with page.route, which never
// sees requests the site's service worker answers from its precache.
test.use({serviceWorkers: 'block'});

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

async function markCriticalTest(page, id) {
  // Model a future spec update in the served worker catalog, without changing
  // the pinned production spec or introducing a runtime result-injection API.
  let patched = false;
  await page.route('**/assets/worker-*.js', async route => {
    const response = await route.fetch(), source = await response.text();
    const pattern = new RegExp(`(id:\\s*[\x60"']${id}[\x60"'],\\s*)(verification:)`, 'g');
    const body = source.replace(pattern, '$1severity:"critical",unsafeWhen:"pass",$2');
    expect(body).not.toBe(source);
    patched = true;
    await route.fulfill({response, body});
  });
  return () => expect(patched).toBe(true);
}

for (const embedded of [false, true]) test(`critical pass terminates the actual worker and retains diagnostics (${embedded ? 'embedded' : 'standalone'})`, async ({page}) => {
  const checkPatched = await markCriticalTest(page, 'PKG-001');
  await page.addInitScript(() => {
    const Worker = window.Worker;
    window.workerTerminations = 0;
    window.Worker = class extends Worker {
      terminate() { window.workerTerminations++; return super.terminate(); }
    };
  });
  await page.goto(embedded ? '/' : '/emulator/');
  if (embedded) await page.locator('#browser-workbench[open]').waitFor();
  const panel = embedded ? page.frameLocator('#emulator-frame') : page;
  await panel.locator('#image').setInputFiles(firmware());
  await panel.getByText('Developer debugging', {exact: true}).click();
  await panel.locator('#debug-enabled').check();
  await panel.locator('#run').click();
  await panel.locator('#validate-image').click();
  await expect(panel.locator('#safety-stop')).toContainText('Do not flash this firmware to a real device.');
  await expect(panel.locator('#safety-stop')).toContainText('PKG-001');
  await expect(panel.locator('#validation-summary')).toContainText('UNSAFE');
  await expect(panel.locator('#validation-rows tr[data-unsafe=true]')).toContainText('PASS · UNSAFE');
  expect(await page.evaluate(() => window.workerTerminations)).toBe(1);
  for (const id of ['run', 'step', 'reset', 'version', 'update', 'poweroff', 'image', 'validate-image', 'send-midi', 'replay', 'debug-enabled', 'debug-step', 'debug-read']) {
    await expect(panel.locator('#' + id)).toBeDisabled();
  }
  await expect(panel.locator('[data-control]').first()).toBeDisabled();
  const report = await downloaded(page, () => panel.locator('#validation-save').click());
  expect(report.results[0]).toMatchObject({id: 'PKG-001', severity: 'critical', unsafeWhen: 'pass', status: 'pass'});
  const execution = await downloaded(page, () => panel.locator('#report').click());
  const debug = await downloaded(page, () => panel.locator('#debug-save').click());
  expect(execution.status).toBe('terminated'); expect(debug).toEqual(execution);
  expect(execution.conformance).toEqual(report);
  if (embedded) {
    const blocked = await page.evaluate(async () => {
      const device = window.sq64Emulator;
      const results = await Promise.allSettled(['run', 'step', 'reset', 'midi', 'load'].map(action => device.request(action)));
      return {rejected: results.every(result => result.status === 'rejected'), worker: device.worker,
        ports: [device.input.state, device.output.state], state: await device.request('state')};
    });
    expect(blocked.rejected).toBe(true); expect(blocked.worker).toBeNull();
    expect(blocked.ports).toEqual(['disconnected', 'disconnected']);
    expect(blocked.state.report).toEqual(execution);
    await page.frames().find(frame => frame.url().includes('/emulator/')).goto('/emulator/');
    await expect(panel.locator('#safety-stop')).toBeVisible();
    await page.locator('#browser-workbench[open]').waitFor();
    await expect(page.locator('#emulator-safety-stop')).toBeVisible();
  }
  checkPatched();
});

test('a critical detector that fails does not terminate execution', async ({page}) => {
  const checkPatched = await markCriticalTest(page, 'PKG-005');
  await page.goto('/emulator/');
  await page.locator('#image').setInputFiles(firmware(true));
  await page.locator('#run').click();
  await page.locator('#validate-image').click();
  await expect(page.locator('#validation-summary')).toContainText('FAIL');
  await expect(page.locator('#safety-stop')).toHaveCount(0);
  await expect(page.locator('#status')).toContainText('Running');
  await expect(page.locator('#reset')).toBeEnabled();
  checkPatched();
});

test('Validate Image preserves a stopped debugger and exports the exact loaded image checks', async ({page}) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/'); await page.locator('#browser-workbench[open]').waitFor();
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
  await page.goto('/'); await page.locator('#browser-workbench[open]').waitFor();
  const panel = page.frameLocator('#emulator-frame'); await panel.locator('#image').setInputFiles(firmware());
  await page.evaluate(() => window.sq64Emulator.setLocked(true));
  await expect(panel.locator('#validate-image')).toBeDisabled();
  await page.evaluate(() => window.sq64Emulator.setLocked(false));
  await expect(panel.locator('#validate-image')).toBeEnabled();
});
