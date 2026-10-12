import {CHECKSUM_REGIONS, IMAGE_SIZE} from '../src/protocol.js';
export function syntheticVsb() {
  // Deliberately non-executable synthetic data; never install on hardware.
  const data = new Uint8Array(256 + IMAGE_SIZE); data.fill(0xff, 0, 256);
  const text = new TextEncoder(), v = new DataView(data.buffer);
  data.set(text.encode('KORG SYSTEM FILE')); data.fill(0, 16, 40);
  data.set(text.encode('SQ-64'), 16); data.set(text.encode('SYSTEM'), 32);
  data[0x29] = 0; data[0x2a] = 2; data[0x2b] = 4; data.set([0, 1, 0x60, 0xff], 0x2c);
  [0, IMAGE_SIZE, 0, IMAGE_SIZE].forEach((x, i) => v.setUint32(0x30 + i * 4, x, true));
  const p = new DataView(data.buffer, 256);
  p.setUint32(0, 0x20040000, true); p.setUint32(4, 0x00200041, true);
  for (const [offset, length] of CHECKSUM_REGIONS) {
    let sum = 0; for (let i = offset; i < offset + length - 2; i += 2) sum += p.getUint16(i, true);
    p.setUint16(offset + length - 2, -sum & 65535, true);
  }
  return data;
}
