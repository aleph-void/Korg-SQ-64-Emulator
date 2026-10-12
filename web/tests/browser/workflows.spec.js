import {test, expect} from './fixtures.js';
import {syntheticVsb} from '../fixtures.js';

test.beforeEach(async ({page}) => { await page.goto('/'); });
test('Aleph Void identity, canonical domain and entirely local assets', async ({page}) => {
  const remote = []; page.on('request', r => { if (!r.url().startsWith('http://127.0.0.1:4173/')) remote.push(r.url()); });
  await page.reload();
  await expect(page).toHaveTitle('SQ-64 Device Tools | Aleph Void');
  await expect(page.locator('link[rel=canonical]')).toHaveAttribute('href', 'https://sq64.alephvoid.com/');
  await expect(page.getByRole('button', {name: 'Download backup'})).toBeDisabled();
  expect(remote).toEqual([]);
});
test('capture and restore an original synthetic current-project archive', async ({page}) => {
  await page.getByRole('button', {name: 'Try a simulated device'}).click();
  await page.locator('#scope').selectOption('current');
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', {name: 'Download backup'}).click();
  const path = await (await downloaded).path();
  await page.getByRole('button', {name: 'Restore', exact: true}).click();
  await page.locator('#backup-file').setInputFiles(path);
  await page.locator('#restore-ready').check();
  await expect(page.locator('#restore-start')).toBeEnabled();
  await page.locator('#restore-start').click();
  await expect(page.locator('#status')).toContainText('Restore');
});
test('validating files and confirming completion are separate steps', async ({page}) => {
  await page.locator('#demo').click();
  await page.getByRole('button', {name: 'Update firmware'}).click();
  await page.locator('#firmware').setInputFiles({name: 'bad.vsb', mimeType: 'application/octet-stream', buffer: Buffer.from('invalid')});
  await expect(page.locator('#update-start')).toBeDisabled();
  await page.locator('#firmware').setInputFiles({name: 'synthetic-never-flash.vsb', mimeType: 'application/octet-stream', buffer: Buffer.from(syntheticVsb())});
  await page.locator('#ready').check();
  await expect(page.locator('#update-start')).toBeEnabled();
  await page.locator('#update-start').click();
  await expect(page.locator('#completion')).toBeVisible();
  await expect(page.locator('#status')).not.toContainText('Device confirmed');
  await page.locator('#confirm-completion').click();
  await expect(page.locator('#status')).toContainText('confirmed');
});
test('works at mobile width and rejects an incomplete restore archive', async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await page.locator('#demo').click();
  await page.getByRole('button', {name: 'Restore', exact: true}).click();
  await page.locator('#backup-file').setInputFiles({name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"complete":false}')});
  await page.locator('#restore-ready').check();
  await expect(page.locator('#restore-start')).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
