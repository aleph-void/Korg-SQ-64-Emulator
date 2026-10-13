import {test, expect} from './fixtures.js';

const workerState = page => page.evaluate(async () => {
  const registration = await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, {once: true}));
  }
  const names = (await caches.keys()).filter(name => name.startsWith('sq64-'));
  const cached = await caches.open(names[0]).then(cache => cache.keys());
  return {scope: registration.scope, caches: names, cached: cached.length};
});

test('both pages link valid installable manifests', async ({page, baseURL}) => {
  for (const [path, name] of [['/', 'SQ-64 Device Tools'], ['/emulator/', 'SQ-64 Emulator']]) {
    await page.goto(path);
    await expect(page.locator('link[rel=manifest]')).toHaveAttribute('href', 'manifest.webmanifest');
    const manifest = await (await page.request.get(baseURL + path + 'manifest.webmanifest')).json();
    expect(manifest.name).toBe(name);
    expect(manifest.start_url).toBe('./');
    expect(manifest.display).toBe('standalone');
    expect(manifest.icons.map(icon => icon.sizes).sort()).toEqual(['192x192', '512x512', '512x512']);
    for (const icon of manifest.icons) {
      expect((await page.request.get(new URL(icon.src, baseURL + path + 'manifest.webmanifest').href)).ok()).toBe(true);
    }
  }
});

test('service worker precaches the site and serves it offline', async ({page, context, baseURL}) => {
  await page.goto('/');
  const state = await workerState(page);
  expect(state.scope).toBe(baseURL + '/');
  expect(state.caches).toHaveLength(1);
  expect(state.cached).toBeGreaterThan(30);
  await context.setOffline(true);
  await page.goto('/emulator/');
  await page.getByText('Try the emulator without vendor firmware', {exact: true}).click();
  await page.locator('#load-probe').click();
  await expect(page.locator('#status')).toContainText('Running');
  await context.setOffline(false);
});

test('service worker scopes to the repository path export', async ({page, baseURL}) => {
  await page.goto('/dist/');
  expect((await workerState(page)).scope).toBe(baseURL + '/dist/');
});
