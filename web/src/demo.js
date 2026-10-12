import {frame, parseFrame, pack, integer, decodeInteger, unpack} from './protocol.js';
import {normalPrefix} from './backup.js';

// Original synthetic protocol peer. It never opens a MIDI device.
export class DemoSession {
  constructor() { this.closed = false; this.next = 0; this.project = null; this.frames = []; this.restored = new Map(); }
  close() { this.closed = true; }
  async exchange(data, {progress} = {}) {
    if (this.closed) throw Error('Session closed');
    this.frames.push(Array.from(data));
    if (data[2] === 0x23) {
      const {command, body} = parseFrame(data);
      if (command === 0) return frame(1, [1, ...integer(1024), 2]);
      if (command === 2) return frame(3, [2, 3]);
      if (command === 4) { this.next = 0; return frame(5, [0]); }
      if ([6, 8].includes(command)) {
        if (decodeInteger(body.slice(0, 4)) !== this.next++) return frame(5, [5]);
        if (command === 6) {
          const packed = body.slice(4, -1);
          unpack(packed, 1024);
          if ((packed.reduce((n, b) => n + b, 0) & 127) !== body.at(-1)) return frame(5, [6]);
        }
        if (this.next % 32 === 0) progress?.(frame(0x13, [...integer(this.next, 2), ...integer(224, 2)]));
        return frame(5, [0]);
      }
      throw Error('Unsupported demo update command');
    }
    const prefix = normalPrefix(data[2] - 0x30), {command, body} = parseFrame(data, prefix);
    if (command === 0x70) { this.project = null; return frame(0x23, [], prefix); }
    if ([0x41, 0x4d, 0x48, 0x49, 0x44, 0x45, 0x47, 0x50].includes(command)) {
      this.restored.set(`${command}/${body[0]}`, data.slice());
      return frame(0x23, [], prefix);
    }
    const kinds = {14: [0x50, 512, 'GLOB'], 20: [0x44, 2048, 'CTRL'], 21: [0x45, 2048, 'CTRL'], 23: [0x47, 36, null], 17: [0x41, 512, 'PROJ'], 29: [0x4d, 512, 'PROJ'], 24: [0x48, 3104, null], 25: [0x49, 6176, null]};
    const config = kinds[command];
    if (!config) throw Error('Unsupported demo backup request');
    if ([0x17, 0x1d, 0x15].includes(command) && body[0] > 0) return frame(0x30, [], prefix);
    const raw = new Uint8Array(config[1]);
    if (config[2]) raw.set(new TextEncoder().encode(config[2]));
    if (config[2] === 'PROJ') { raw[40] = 1; raw[46] = 1; this.project = body[0] ?? 'current'; }
    if ([0x18, 0x19].includes(command) && this.project === null) throw Error('Pattern requested outside project session');
    return frame(config[0], [...body, ...pack(raw)], prefix);
  }
}
