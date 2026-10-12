import {createHash} from 'node:crypto';
import {test, expect} from './fixtures.js';
import {syntheticVsb} from '../fixtures.js';

const REGISTRY = 'https://sq64-custom-firmware.alephvoid.com/';
const sha256 = data => createHash('sha256').update(data).digest('hex');

// Registry requests are cross-origin and ignored by the app's service worker,
// but a controlling worker still hides them from page.route; block it so the
// stub registry below serves these tests.
test.use({serviceWorkers: 'block'});

// The registry is contacted only after the user asks for the list; the
// local-assets workflow test keeps guarding the initial page load.
function serveRegistry(page, {requests = []} = {}) {
  const image = syntheticVsb();
  const script = Buffer.from(JSON.stringify({format: 'sq64-ui-script', version: 1, name: 'Synthetic demo groove',
    actions: [{type: 'press', control: 'play', ms: 100}]}));
  const index = JSON.stringify({format: 'sq64-firmware-registry', version: 1, entries: [{
    id: 'synthetic', name: 'Synthetic Demo', description: 'Non-executable synthetic registry firmware for tests.',
    repo: 'https://github.com/aleph-void/Korg-SQ-64-Euclidean-Firmware', ref: 'a'.repeat(40),
    file: 'firmware/synthetic/synthetic.vsb', sha256: sha256(image), bytes: image.length,
    validation: 'reports/synthetic/validation.json',
    scripts: [{name: 'Synthetic demo groove', file: 'firmware/synthetic/scripts/groove.json', sha256: sha256(script)}],
  }]});
  return page.route(`${REGISTRY}**`, route => {
    const path = route.request().url().slice(REGISTRY.length);
    requests.push(path);
    const body = path === 'index.json' ? Buffer.from(index)
      : path === 'firmware/synthetic/synthetic.vsb' ? Buffer.from(image)
        : path === 'firmware/synthetic/scripts/groove.json' ? script : null;
    return body ? route.fulfill({body, contentType: 'application/octet-stream'}) : route.fulfill({status: 404, body: ''});
  });
}

test('loads listed community firmware and imports its UI scripts on demand', async ({page}) => {
  const requests = [];
  await serveRegistry(page, {requests});
  await page.goto('/');
  await page.locator('#browser-workbench[open]').waitFor();
  const panel = page.frameLocator('#emulator-frame');
  expect(requests).toEqual([]);
  await panel.locator('#repo-browse').click();
  await expect(panel.locator('#repo-status')).toContainText('1 validated firmware image available');
  await expect(panel.locator('#repo-list')).toHaveValue('synthetic');
  await expect(panel.getByText('Non-executable synthetic registry firmware for tests.')).toBeVisible();
  await panel.locator('#repo-load').click();
  await expect(panel.locator('#image-status')).toContainText('Loaded: Synthetic Demo · firmware repository');
  await expect(panel.locator('#repo-status')).toContainText('imported 1 UI script');
  expect(requests).toEqual(['index.json', 'firmware/synthetic/synthetic.vsb', 'firmware/synthetic/scripts/groove.json']);
  await panel.locator('#ui-scripts summary').click();
  await expect(panel.locator('#script-library option', {hasText: 'Synthetic demo groove'})).toHaveCount(1);
  // Re-loading updates the stored copy instead of duplicating it.
  await panel.locator('#repo-load').click();
  await expect(panel.locator('#repo-status')).toContainText('imported 1 UI script');
  await panel.locator('#script-refresh').click();
  await expect(panel.locator('#script-library option', {hasText: 'Synthetic demo groove'})).toHaveCount(1);
});

test('rejects registry firmware whose bytes do not match the manifest', async ({page}) => {
  const image = syntheticVsb();
  const index = JSON.stringify({format: 'sq64-firmware-registry', version: 1, entries: [{
    id: 'tampered', name: 'Tampered', description: 'Hash mismatch fixture.', repo: 'https://example.com/x',
    file: 'firmware/tampered/t.vsb', sha256: 'f'.repeat(64), bytes: image.length, scripts: [],
  }]});
  await page.route(`${REGISTRY}**`, route => route.fulfill(
    route.request().url().endsWith('index.json') ? {body: index, contentType: 'application/json'}
      : {body: Buffer.from(image), contentType: 'application/octet-stream'}));
  await page.goto('/');
  await page.locator('#browser-workbench[open]').waitFor();
  const panel = page.frameLocator('#emulator-frame');
  await panel.locator('#repo-browse').click();
  await panel.locator('#repo-load').click();
  await expect(panel.locator('#repo-status')).toContainText('does not match the SHA-256');
  await expect(panel.locator('#image-status')).toContainText('does not match the SHA-256');
});
