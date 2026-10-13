import { sha256 } from '../src/protocol.js';
import { MAX_SCRIPT_BYTES, validateScript } from './scripts.js';
import { saveScript } from './script-store.js';

// The community firmware registry publishes images only after building them
// from a pinned public commit and passing the conformance image profile, a
// headless emulator execution with critical detectors armed, and UI script
// validation. See https://github.com/aleph-void/Korg-SQ-64-Custom-Firmware-Repo
export const REGISTRY_URL = 'https://sq64-custom-firmware.alephvoid.com/';
export const REGISTRY_FORMAT = 'sq64-firmware-registry';
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_INDEX_BYTES = 1024 * 1024;
const PATH = /^[\w./-]+$/;
const HASH = /^[0-9a-f]{64}$/;

const text = (value, limit) => typeof value === 'string' && value.trim() && value.length <= limit;
const path = value => typeof value === 'string' && value.length <= 300 && PATH.test(value) &&
  !value.split('/').some(part => !part || part === '..');

async function download(url, limit, { fetch = globalThis.fetch, signal } = {}) {
  const response = await fetch(url, { signal, cache: 'no-cache' });
  if (!response.ok) throw Error(`The firmware repository returned ${response.status} for ${url}`);
  const data = await response.arrayBuffer();
  if (data.byteLength > limit) throw Error('The firmware repository response is too large');
  return data;
}

function entryValid(entry) {
  return entry !== null && typeof entry === 'object' &&
    text(entry.id, 40) && text(entry.name, 80) && text(entry.description, 400) &&
    typeof entry.repo === 'string' && entry.repo.startsWith('https://') &&
    path(entry.file) && HASH.test(entry.sha256 || '') &&
    (entry.validation === undefined || path(entry.validation)) &&
    Number.isInteger(entry.bytes) && entry.bytes > 0 && entry.bytes <= MAX_IMAGE_BYTES &&
    Array.isArray(entry.scripts) && entry.scripts.length <= 16 &&
    entry.scripts.every(script => script !== null && typeof script === 'object' &&
      text(script.name, 120) && path(script.file) && HASH.test(script.sha256 || ''));
}

// Fetched only on an explicit user action — the repository button or a
// ?firmware= deep link. A plain page load never contacts the registry.
export async function fetchRegistry(options = {}) {
  const base = options.url || REGISTRY_URL;
  let index;
  try {
    index = JSON.parse(new TextDecoder().decode(await download(base + 'index.json', MAX_INDEX_BYTES, options)));
  } catch (error) {
    throw Error(error.message.startsWith('The firmware repository') ? error.message
      : `The firmware repository is unreachable: ${error.message}`);
  }
  if (index?.format !== REGISTRY_FORMAT || index.version !== 1 || !Array.isArray(index.entries) ||
      index.entries.length > 500 || !index.entries.every(entryValid))
    throw Error('The firmware repository manifest is not a valid registry index');
  return index.entries;
}

async function verified(base, { file, sha256: expected }, limit, options) {
  const data = await download(base + file, limit, options);
  if (await sha256(data) !== expected)
    throw Error(`Downloaded ${file} does not match the SHA-256 the registry published for it`);
  return data;
}

export async function fetchFirmware(entry, options = {}) {
  const data = await verified(options.url || REGISTRY_URL, entry, MAX_IMAGE_BYTES, options);
  if (data.byteLength !== entry.bytes) throw Error('Downloaded firmware size does not match the registry manifest');
  return data;
}

// Store the entry's published UI scripts in the browser script library under
// deterministic ids, so reloading a firmware updates rather than duplicates
// them. Scripts are data, never code; validateScript rejects anything else.
export async function importEntryScripts(entry, options = {}) {
  const base = options.url || REGISTRY_URL;
  const scripts = [];
  for (const script of entry.scripts) {
    const data = await verified(base, script, MAX_SCRIPT_BYTES, options);
    scripts.push(validateScript(JSON.parse(new TextDecoder().decode(data))));
  }
  const store = options.saveScript || saveScript;
  for (const [index, script] of scripts.entries())
    await store(script, `registry:${entry.id}:${entry.scripts[index].file.split('/').pop()}`);
  return scripts.length;
}
