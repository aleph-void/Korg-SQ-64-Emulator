// Download metadata only. The vendor image is never part of this repository.
import {parseVsb, sha256} from '../src/protocol.js';
export const OFFICIAL_203 = Object.freeze({
  page: 'https://www.korg.com/us/support/download/software/0/872/4735/',
  url: 'https://cdn.korg.com/jp/support/download/files/765e1fc1c8b5e0fe446fefb7199dd6bf.zip',
  filename: 'sq_64_updater_0203_win.zip',
  sha256: '76c0b95138f7e75f04d2a7ec7ed2e72f3809e45e740436abbb9038a5a8908971',
});
const ZIP_LIMIT = 4 * 1024 * 1024, VSB_SIZE = 0x38100;
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
async function inflateRaw(bytes, limit) {
  let decoder;
  try { decoder = new DecompressionStream('deflate-raw'); }
  catch { throw Error('This browser does not support the ZIP decompression needed to boot official firmware.'); }
  return boundedBytes(new Response(new Blob([bytes]).stream().pipeThrough(decoder)), limit);
}
async function boundedBytes(response, limit) {
  const reader = response.body?.getReader(); if (!reader) throw Error('Download has no readable body');
  const chunks = []; let length = 0;
  try { while (true) { const {done, value} = await reader.read(); if (done) break; length += value.length;
    if (length > limit) throw Error('Firmware package exceeds the allowed size'); chunks.push(value); }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; } return bytes;
}
export async function extractVsb(input, inflate = inflateRaw) {
  const bytes = new Uint8Array(input); if (bytes.length > ZIP_LIMIT || bytes.length < 22) throw Error('Invalid or oversized ZIP');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (v.getUint32(i, true) === 0x06054b50 && i + 22 + v.getUint16(i + 20, true) === bytes.length) { end = i; break; }
  if (end < 0 || v.getUint16(end + 4, true) || v.getUint16(end + 6, true)) throw Error('Unsupported ZIP directory');
  const count = v.getUint16(end + 10, true), size = v.getUint32(end + 12, true), start = v.getUint32(end + 16, true);
  if (count > 128 || v.getUint16(end + 8, true) !== count || start + size !== end) throw Error('Invalid ZIP directory bounds');
  let at = start, selected;
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || v.getUint32(at, true) !== 0x02014b50) throw Error('Invalid ZIP entry');
    const flags = v.getUint16(at + 8, true), method = v.getUint16(at + 10, true), checksum = v.getUint32(at + 16, true), packed = v.getUint32(at + 20, true), length = v.getUint32(at + 24, true);
    const nameLength = v.getUint16(at + 28, true), extraLength = v.getUint16(at + 30, true), commentLength = v.getUint16(at + 32, true), local = v.getUint32(at + 42, true), next = at + 46 + nameLength + extraLength + commentLength;
    if (next > end) throw Error('Truncated ZIP entry');
    const name = new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(at + 46, at + 46 + nameLength));
    if (/\.vsb$/i.test(name)) {
      if (selected || flags & 1 || ![0, 8].includes(method) || length !== VSB_SIZE || packed > ZIP_LIMIT || local + 30 > start || v.getUint32(local, true) !== 0x04034b50 || v.getUint16(local + 6, true) !== flags || v.getUint16(local + 8, true) !== method) throw Error('Unsupported or ambiguous firmware ZIP entry');
      const localNameLength = v.getUint16(local + 26, true), localExtraLength = v.getUint16(local + 28, true), dataStart = local + 30 + localNameLength + localExtraLength;
      if (dataStart + packed > start || localNameLength !== nameLength || !bytes.subarray(local + 30, local + 30 + localNameLength).every((b, j) => b === bytes[at + 46 + j])) throw Error('ZIP local entry does not match directory');
      selected = {data: bytes.subarray(dataStart, dataStart + packed), method, length, checksum};
    }
    at = next;
  }
  if (at !== end || !selected) throw Error('ZIP does not contain one SQ-64 VSB');
  const result = selected.method === 0 ? selected.data.slice() : await inflate(selected.data, selected.length);
  if (result.length !== selected.length || crc32(result) !== selected.checksum) throw Error('ZIP firmware length or checksum mismatch');
  return result;
}
export async function verifyOfficial203(input) {
  const bytes = new Uint8Array(input), image = bytes[0] === 0x50 && bytes[1] === 0x4b ? await extractVsb(bytes) : bytes;
  if (image.length !== VSB_SIZE || await sha256(image) !== OFFICIAL_203.sha256) throw Error('This is not the verified official Korg 2.03 firmware');
  const parsed = parseVsb(image); if (parsed.version[0] !== 2 || parsed.version[1] !== 3) throw Error('Unexpected official firmware version');
  return image;
}
export async function fetchOfficial203({fetcher = fetch, signal} = {}) {
  const response = await fetcher(OFFICIAL_203.url, {mode: 'cors', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal});
  if (!response.ok || response.type === 'opaque') throw Error('Korg firmware download is unavailable');
  return verifyOfficial203(await boundedBytes(response, ZIP_LIMIT));
}
