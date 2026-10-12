import {SPI_SIZE} from './flash.js';
import {sha256} from '../src/protocol.js';
export const FLASH = 0x200000, SRAM = 0x20000000;
export async function loadImage(input) {
  const bytes = new Uint8Array(input), sha = await sha256(bytes);
  let payload = bytes, format = 'bin', segments = [];
  const spi = new Uint8Array(SPI_SIZE).fill(255);
  if (bytes[0] === 127 && String.fromCharCode(...bytes.slice(1, 4)) === 'ELF') {
    format = 'elf'; const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 52 || bytes[4] !== 1 || bytes[5] !== 1 || v.getUint16(18, true) !== 40) throw Error('Expected little-endian ARM32 ELF');
    const start = v.getUint32(28, true), stride = v.getUint16(42, true), count = v.getUint16(44, true);
    if (stride < 32 || count > 128 || start + stride * count > bytes.length) throw Error('Invalid ELF program headers');
    for (let i = 0; i < count; i++) {
      const o = start + stride * i; if (v.getUint32(o, true) !== 1) continue;
      const file = v.getUint32(o + 4, true), size = v.getUint32(o + 16, true);
      let address = v.getUint32(o + 12, true); if (address >= 0x8000000 && address < 0x8010000) address -= 0x7e00000;
      if (!size) continue;
      if (file + size > bytes.length || ![[FLASH, 65536], [0, 16384], [SRAM, 0x40000]].some(([a, n]) => address >= a && address + size <= a + n)) throw Error('ELF segment outside modeled memory');
      if (segments.some(s => address < s.address + s.data.length && s.address < address + size)) throw Error('Overlapping ELF segments');
      segments.push({address, data: bytes.slice(file, file + size)});
    }
  } else {
    if (new TextDecoder().decode(bytes.slice(0, 16)) === 'KORG SYSTEM FILE') {
      if (bytes.length !== 0x38100 || bytes[0x29] !== 0 || ![0, 1, 96, 255].every((b, i) => bytes[0x2c + i] === b)) throw Error('Unsupported VSB');
      const v = new DataView(bytes.buffer, bytes.byteOffset);
      if (![0, 0x38000, 0, 0x38000].every((n, i) => v.getUint32(0x30 + i * 4, true) === n)) throw Error('Unsupported VSB geometry');
      payload = bytes.slice(256); format = 'vsb';
    }
    if (![65536, 0x38000].includes(payload.length)) throw Error('Load a 64 KiB flash, 224 KiB payload, VSB or ARM ELF');
    segments = [{address: FLASH, data: payload.slice(0, 65536)}];
    if (payload.length === 0x38000) for (const [s, d, n] of [[0x10000, 0, 0x4000], [0x34000, 0x4000, 0x4000], [0x14000, 0x10000, 0x20000]]) spi.set(payload.subarray(s, s + n), d);
  }
  const vector = segments.find(s => s.address === FLASH && s.data.length >= 8);
  if (!vector) throw Error('Reset vectors must be present at 0x00200000');
  const v = new DataView(vector.data.buffer, vector.data.byteOffset), stack = v.getUint32(0, true), reset = v.getUint32(4, true);
  if (stack <= SRAM || stack > SRAM + 0x40000 || stack % 8 || !(reset & 1) || !segments.some(s => (reset & ~1) >= s.address && (reset & ~1) < s.address + s.data.length)) throw Error('Invalid stack or reset vector');
  return {segments, spi, stack, reset, sha256: sha, format};
}
