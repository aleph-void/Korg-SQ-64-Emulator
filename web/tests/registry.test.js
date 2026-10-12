import test from 'node:test';
import assert from 'node:assert/strict';
import { REGISTRY_FORMAT, MAX_IMAGE_BYTES, fetchRegistry, fetchFirmware, importEntryScripts } from '../emulator/registry.js';
import { sha256 } from '../src/protocol.js';
import { SCRIPT_FORMAT } from '../emulator/scripts.js';

const image = new Uint8Array(1024).map((_, i) => i & 255);
const uiScript = { format: SCRIPT_FORMAT, version: 1, name: 'Demo groove', actions: [{ type: 'press', control: 'play', ms: 100 }] };
const scriptBytes = new TextEncoder().encode(JSON.stringify(uiScript));

async function entry(overrides = {}) {
  return { id: 'demo', name: 'Demo', description: 'A demo firmware', repo: 'https://example.com/demo',
    ref: 'a'.repeat(40), file: 'firmware/demo/demo.vsb', sha256: await sha256(image), bytes: image.length,
    validation: 'reports/demo/validation.json',
    scripts: [{ name: 'Demo groove', file: 'firmware/demo/scripts/groove.json', sha256: await sha256(scriptBytes) }],
    ...overrides };
}

function server(index, files = {}) {
  const requests = [];
  return { requests, async fetch(url) {
    requests.push(url);
    const path = url.replace('https://registry.test/', '');
    const body = path === 'index.json' ? new TextEncoder().encode(JSON.stringify(index)) : files[path];
    return body ? { ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) }
      : { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
  } };
}
const url = 'https://registry.test/';
const index = async entries => ({ format: REGISTRY_FORMAT, version: 1, entries });

test('fetchRegistry returns validated entries and is only called on demand', async () => {
  const { fetch, requests } = server(await index([await entry()]));
  const entries = await fetchRegistry({ url, fetch });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'Demo');
  assert.deepEqual(requests, ['https://registry.test/index.json']);
});

test('fetchRegistry rejects malformed manifests', async () => {
  for (const bad of [
    { format: 'other', version: 1, entries: [] },
    { format: REGISTRY_FORMAT, version: 2, entries: [] },
    await index([await entry({ sha256: 'short' })]),
    await index([await entry({ file: '../escape.vsb' })]),
    await index([await entry({ file: 'https://elsewhere.test/x.vsb' })]),
    await index([await entry({ bytes: MAX_IMAGE_BYTES + 1 })]),
    await index([await entry({ scripts: [{ name: 'x', file: 'a/../b.json', sha256: 'f'.repeat(64) }] })]),
  ]) {
    await assert.rejects(fetchRegistry({ url, fetch: server(bad).fetch }), /registry index/);
  }
  await assert.rejects(fetchRegistry({ url, fetch: server({}, {}).fetch, }), /not a valid registry index/);
  await assert.rejects(fetchRegistry({ url: 'https://registry.test/missing/', fetch: server({}).fetch }), /404/);
});

test('fetchFirmware verifies the published SHA-256 and size', async () => {
  const good = await entry();
  const files = { 'firmware/demo/demo.vsb': image };
  const data = await fetchFirmware(good, { url, fetch: server({}, files).fetch });
  assert.equal(new Uint8Array(data)[2], 2);
  await assert.rejects(fetchFirmware({ ...good, sha256: 'f'.repeat(64) }, { url, fetch: server({}, files).fetch }), /SHA-256/);
  await assert.rejects(fetchFirmware({ ...good, bytes: 999 }, { url, fetch: server({}, files).fetch }), /size does not match/);
  await assert.rejects(fetchFirmware(good, { url, fetch: server({}, {}).fetch }), /404/);
});

test('importEntryScripts validates, verifies and stores scripts under stable ids', async () => {
  const saved = [];
  const files = { 'firmware/demo/scripts/groove.json': scriptBytes };
  const count = await importEntryScripts(await entry(), { url, fetch: server({}, files).fetch,
    saveScript: async (script, id) => saved.push({ script, id }) });
  assert.equal(count, 1);
  assert.deepEqual(saved.map(item => item.id), ['registry:demo:groove.json']);
  assert.equal(saved[0].script.name, 'Demo groove');
});

test('importEntryScripts stores nothing when any script is corrupt', async () => {
  const saved = [];
  const bad = new TextEncoder().encode(JSON.stringify({ ...uiScript, actions: [{ type: 'nope' }] }));
  const corrupt = await entry({ scripts: [
    { name: 'Good', file: 'firmware/demo/scripts/groove.json', sha256: await sha256(scriptBytes) },
    { name: 'Bad', file: 'firmware/demo/scripts/bad.json', sha256: await sha256(bad) },
  ] });
  const files = { 'firmware/demo/scripts/groove.json': scriptBytes, 'firmware/demo/scripts/bad.json': bad };
  await assert.rejects(importEntryScripts(corrupt, { url, fetch: server({}, files).fetch,
    saveScript: async (script, id) => saved.push(id) }), /Action 1/);
  assert.deepEqual(saved, []);
});

test('tampered script bytes are rejected before validation', async () => {
  const files = { 'firmware/demo/scripts/groove.json': new TextEncoder().encode('{"tampered":true}') };
  await assert.rejects(importEntryScripts(await entry(), { url, fetch: server({}, files).fetch,
    saveScript: async () => { throw Error('must not be called'); } }), /SHA-256/);
});
