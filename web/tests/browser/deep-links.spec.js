import {createHash} from 'node:crypto';
import {test, expect} from './fixtures.js';

const REGISTRY = 'https://sq64-custom-firmware.alephvoid.com/';
const sha256 = data => createHash('sha256').update(data).digest('hex');

// Registry requests are cross-origin and ignored by the app's service worker,
// but a controlling worker still hides them from page.route; block it so the
// stub registry below serves these tests.
test.use({serviceWorkers: 'block'});

// Original power-probe.s: assert PB7, poll the power button, release PB7. The
// linked script can therefore power on, run, and complete a real shutdown.
function powerProbe() {
  const bytes = Buffer.alloc(65536);
  bytes.writeUInt32LE(0x20040000, 0); bytes.writeUInt32LE(0x200009, 4);
  bytes.set([0x06,0x48,0x80,0x21,0x01,0x60,0x06,0x4a,0x42,0xf2,0,3,
    0x11,0x68,0x19,0x42,0xfc,0xd1,0x4f,0xf4,0,1,1,0x60,0xfe,0xe7,0,0,
    0x18,4,2,0x40,0x10,8,2,0x40], 8);
  return bytes;
}

function serveRegistry(page, {requests = []} = {}) {
  const image = powerProbe();
  const script = Buffer.from(JSON.stringify({format: 'sq64-ui-script', version: 1, name: 'Linked demo',
    actions: [{type: 'power-on', mode: 'normal'}, {type: 'wait', ms: 100}, {type: 'power-off'}]}));
  const index = JSON.stringify({format: 'sq64-firmware-registry', version: 1, entries: [{
    id: 'linked', name: 'Linked Demo', description: 'Deep-link fixture firmware.',
    repo: 'https://github.com/aleph-void/Korg-SQ-64-Euclidean-Firmware', ref: 'a'.repeat(40),
    file: 'firmware/linked/linked.bin', sha256: sha256(image), bytes: image.length,
    scripts: [{name: 'Linked demo', file: 'firmware/linked/scripts/demo.json', sha256: sha256(script)}],
  }]});
  return page.route(`${REGISTRY}**`, route => {
    const path = route.request().url().slice(REGISTRY.length);
    requests.push(path);
    const body = path === 'index.json' ? Buffer.from(index)
      : path === 'firmware/linked/linked.bin' ? Buffer.from(image)
        : path === 'firmware/linked/scripts/demo.json' ? script : null;
    return body ? route.fulfill({body, contentType: 'application/octet-stream'}) : route.fulfill({status: 404, body: ''});
  });
}

test('a deep link loads repository firmware and runs its named script to completion', async ({page}) => {
  const requests = [];
  await serveRegistry(page, {requests});
  await page.goto('/emulator/?firmware=linked&script=Linked%20demo');
  await expect(page.locator('#image-status')).toContainText('Loaded: Linked Demo · firmware repository');
  await expect(page.locator('#workbench-tab-scripts')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#script-library')).toHaveValue(/registry:linked/);
  await expect(page.locator('#script-status')).toHaveText('Script complete · powered off');
  await expect(page.locator('#status')).toContainText('Powered off');
  expect(requests).toEqual(['index.json', 'firmware/linked/linked.bin', 'firmware/linked/scripts/demo.json']);
});

test('the top-level page forwards deep-link parameters to the embedded workbench', async ({page}) => {
  await serveRegistry(page);
  await page.goto('/?firmware=linked&tool=inspect');
  await page.locator('#browser-workbench').waitFor();
  const panel = page.frameLocator('#emulator-frame');
  await expect(panel.locator('#image-status')).toContainText('Loaded: Linked Demo · firmware repository');
  await expect(panel.locator('#repo-status')).toContainText('imported 1 UI script');
  await expect(panel.locator('#workbench-tab-inspect')).toHaveAttribute('aria-selected', 'true');
});

test('a probe deep link starts the bundled integration probe without the registry', async ({page}) => {
  const requests = [];
  await serveRegistry(page, {requests});
  await page.goto('/emulator/?firmware=probe');
  await expect(page.locator('#image-status')).toContainText('Loaded: Original integration probe');
  await expect(page.locator('#status')).toContainText('Running');
  expect(requests).toEqual([]);
});

test('create link copies a shareable deep link once firmware and a saved script are set', async ({page, context}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await serveRegistry(page);
  await page.goto('/emulator/');
  await page.locator('#workbench-tab-scripts').click();
  await expect(page.locator('#script-link')).toBeDisabled();
  await page.locator('#workbench-tab-firmware').click();
  await page.locator('#repo-browse').click();
  await page.locator('#repo-load').click();
  await expect(page.locator('#image-status')).toContainText('Loaded: Linked Demo · firmware repository');
  await page.locator('#workbench-tab-scripts').click();
  await expect(page.locator('#script-link')).toBeDisabled();
  await page.locator('#script-library').selectOption({label: 'Linked demo'});
  await page.locator('#script-link').click();
  await expect(page.locator('#script-status')).toContainText('Link copied. It loads the firmware and runs its published script.');
  expect(await page.evaluate(() => navigator.clipboard.readText()))
    .toBe('http://127.0.0.1:4173/emulator/?firmware=linked&script=Linked+demo');
  // Replacing the repository image with a local file leaves nothing to link to.
  await page.locator('#image').setInputFiles({name: 'local.bin', mimeType: 'application/octet-stream', buffer: powerProbe()});
  await expect(page.locator('#image-status')).toContainText('Loaded: local.bin');
  await expect(page.locator('#script-link')).toBeDisabled();
});

test('embedded create link points at the top-level page and reproduces the followed link', async ({page, context}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await serveRegistry(page);
  await page.goto('/?firmware=linked&script=Linked%20demo');
  const panel = page.frameLocator('#emulator-frame');
  await expect(panel.locator('#script-status')).toHaveText('Script complete · powered off');
  await panel.locator('#script-link').click();
  await expect(panel.locator('#script-status')).toContainText('Link copied');
  expect(await page.evaluate(() => navigator.clipboard.readText()))
    .toBe('http://127.0.0.1:4173/?firmware=linked&script=Linked+demo');
});

test('broken deep links report the problem instead of loading anything', async ({page}) => {
  await serveRegistry(page);
  await page.goto('/emulator/?firmware=missing');
  await expect(page.locator('#repo-status')).toContainText('lists no image with id “missing”');
  await expect(page.locator('#status')).toContainText('lists no image with id “missing”');
  await page.goto('/emulator/?script=Linked%20demo');
  await expect(page.locator('#status')).toContainText('needs a firmware parameter');
});
