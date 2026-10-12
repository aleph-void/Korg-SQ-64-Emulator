// Independently implemented host protocol. No device firmware is included.
export const VUP = [0xf0, 0x42, 0x23, 0, 1, 0x60];
export const IMAGE_SIZE = 0x38000;
export const CHECKSUM_REGIONS = [[0, 0x10000], [0x10000, 0x4000], [0x14000, 0xbdd8], [0x20000, 0x14000]];
export const bytes = value => value instanceof Uint8Array ? value : new Uint8Array(value);
export const hex = value => Array.from(value, b => b.toString(16).padStart(2, '0')).join('');
export function unhex(value) {
  if (typeof value !== 'string' || value.length % 2 || !/^[0-9a-f]*$/i.test(value)) throw Error('Invalid hexadecimal data');
  return Uint8Array.from(value.match(/../g) || [], s => parseInt(s, 16));
}
export async function sha256(data) { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(data)))); }
export function integer(value, width = 4) {
  if (![2, 4].includes(width) || !Number.isInteger(value) || value < 0 || value >= 2 ** (7 * width)) throw Error('Protocol integer out of range');
  return Array.from({length: width}, (_, i) => Math.floor(value / 2 ** (7 * (width - i - 1))) & 127);
}
export function decodeInteger(data) {
  if (![2, 4].includes(data.length) || data.some(b => b > 127)) throw Error('Invalid protocol integer');
  return data.reduce((n, b) => n * 128 + b, 0);
}
export function pack(raw) {
  const out = [];
  for (let i = 0; i < raw.length; i += 7) {
    const group = raw.slice(i, i + 7);
    out.push(group.reduce((mask, b, j) => mask | ((b >> 7) << j), 0), ...group.map(b => b & 127));
  }
  return Uint8Array.from(out);
}
export function unpack(packed, length) {
  if (packed.length !== length + Math.ceil(length / 7) || packed.some(b => b > 127)) throw Error('Invalid packed data length or byte');
  const out = [];
  for (let i = 0; i < packed.length; i += 8) {
    const group = packed.slice(i + 1, i + 8), mask = packed[i];
    if (mask >> group.length) throw Error('Noncanonical unused packing bits');
    group.forEach((b, j) => out.push(b | (((mask >> j) & 1) << 7)));
  }
  return Uint8Array.from(out);
}
export function frame(command, body = [], prefix = VUP) {
  if (![command, ...body].every(b => Number.isInteger(b) && b >= 0 && b < 128)) throw Error('SysEx data must be seven bit');
  return Uint8Array.from([...prefix, command, ...body, 0xf7]);
}
export function parseFrame(data, prefix = VUP) {
  if (data.length < prefix.length + 2 || !prefix.every((b, i) => data[i] === b) || data.at(-1) !== 0xf7 || data.slice(prefix.length, -1).some(b => b >= 128)) throw Error('Unexpected SysEx frame');
  return {command: data[prefix.length], body: data.slice(prefix.length + 1, -1)};
}
export class Framer {
  constructor(max = 16384) { this.pending = []; this.max = max; }
  feed(data) {
    const complete = [];
    for (const b of data) {
      if (b >= 0xf8) continue;
      if (b === 0xf0) this.pending = [b];
      else if (this.pending.length && b === 0xf7) { complete.push(Uint8Array.from([...this.pending, b])); this.pending = []; }
      else if (b & 128) this.pending = [];
      else if (this.pending.length) {
        this.pending.push(b);
        if (this.pending.length > this.max) { this.pending = []; throw Error('SysEx message exceeds maximum size'); }
      }
    }
    return complete;
  }
}
export function parseVsb(input) {
  const data = bytes(input), text = (a, b) => new TextDecoder().decode(data.slice(a, b));
  if (data.length < 256 || text(0, 16) !== 'KORG SYSTEM FILE') throw Error('Select an SQ-64 VSB firmware file');
  if (text(16, 32) !== 'SQ-64'.padEnd(16, '\0') || text(32, 40) !== 'SYSTEM\0\0') throw Error('Wrong product or block name');
  if (data[0x29] !== 0 || hex(data.slice(0x2c, 0x30)) !== '000160ff') throw Error('Wrong product ID, member, or block');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const base = view.getUint32(0x30, true), target = view.getUint32(0x34, true), start = view.getUint32(0x38, true), length = view.getUint32(0x3c, true);
  if (base || start || target !== IMAGE_SIZE || length !== IMAGE_SIZE || data.length !== 256 + length) throw Error('Only one complete 0x38000-byte SQ-64 system image is supported');
  const version = [data[0x2a], data[0x2b]];
  if (version[0] >= 64 || version[1] >= 128) throw Error('Invalid firmware version');
  let delay = view.getUint32(0x44, true);
  if (delay === 0xffffffff) delay = 0;
  if (delay > 60000) throw Error('Post-update delay is too long');
  const payload = data.slice(256);
  const p = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const sp = p.getUint32(0, true), reset = p.getUint32(4, true);
  if (sp <= 0x20000000 || sp > 0x20040000 || sp % 8) throw Error('Invalid initial stack pointer');
  if (!(reset & 1) || (reset & ~1) < 0x00200008 || (reset & ~1) >= 0x00210000) throw Error('Invalid reset vector');
  for (const [offset, size] of CHECKSUM_REGIONS) {
    let sum = 0;
    for (let i = offset; i < offset + size; i += 2) sum = (sum + p.getUint16(i, true)) & 65535;
    if (sum) throw Error(`Payload checksum failed at 0x${offset.toString(16)}`);
  }
  return {version, payload, base, start, block: 0, delay, data: data.slice()};
}
export function discovery(data) {
  const {command, body} = parseFrame(data);
  if (command !== 1 || ![0, 1].includes(body[0])) throw Error('Unsupported update protocol');
  const width = body[0] === 1 ? 4 : 2;
  if (body.length !== width + 2) throw Error('Invalid discovery length');
  const advertised = decodeInteger(body.slice(1, 1 + width));
  if (!advertised) throw Error('Device advertised zero packet size');
  return {protocol: body[0], packetSize: Math.min(1024, advertised), flags: body.at(-1)};
}
export function versionReply(data) {
  const {command, body} = parseFrame(data);
  if (command !== 3 || body.length !== 2) throw Error('Invalid version reply');
  return Array.from(body);
}
const ERRORS = ['OK', 'Product ID', 'Member ID', 'Format', 'Block', 'Packet number', 'Checksum', 'Timeout', 'Hardware', 'Flash write', 'Aborted', 'Version'];
export function ack(data) {
  const {command, body} = parseFrame(data);
  if (command === 0x13 && body.length === 4) return {progress: true, done: decodeInteger(body.slice(0, 2)), total: decodeInteger(body.slice(2))};
  if (command !== 5 || !body.length) throw Error('Expected update acknowledgement');
  if (body[0]) throw Error(`Device rejected update: ${ERRORS[body[0]] || 'extended error'} (${body[0]})`);
  if (![1, 2].includes(body.length)) throw Error('Malformed update acknowledgement');
  return {progress: false, separateWrite: Boolean(body[1] & 1)};
}
export function transferPlan(pkg, caps, installed, allowOlder = false) {
  const {protocol, packetSize: size} = caps;
  if (![0, 1].includes(protocol) || !Number.isInteger(size) || size < 1 || size > 1024 || pkg.payload.length % size) throw Error('Unsupported negotiated packet geometry');
  if (!allowOlder && installed[0] * 128 + installed[1] >= pkg.version[0] * 128 + pkg.version[1]) throw Error('Same or older version: explicitly enable reinstall/downgrade');
  const width = protocol ? 4 : 2, count = pkg.payload.length / size;
  if (count > 2 ** (7 * width)) throw Error('Packet index overflow');
  const begin = [0, pkg.block, ...(protocol ? [...integer(0), ...integer(pkg.payload.length)] : []), pkg.version[0] | 0x40, pkg.version[1], ...(protocol ? integer(size) : [])];
  return {begin: frame(4, begin), count, packet(index) {
    if (!Number.isInteger(index) || index < 0 || index >= count) throw Error('Packet index out of range');
    const raw = pkg.payload.slice(index * size, (index + 1) * size), number = integer(index, width);
    if ((caps.flags & 2) && raw.every(b => b === raw[0])) return frame(8, [...number, raw[0] >> 4, raw[0] & 15]);
    const encoded = pack(raw);
    return frame(6, [...number, ...encoded, encoded.reduce((n, b) => n + b, 0) & 127]);
  }};
}
