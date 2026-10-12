export class MidiMessages {
  constructor() { this.pending = []; this.status = null; }
  feed(value) {
    if (value >= 248) return [[value]];
    if (value === 240) { this.pending = [value]; this.status = value; return []; }
    if (value === 247) { const r = this.status === 240 ? [[...this.pending, value]] : []; this.pending = []; this.status = null; return r; }
    if (value & 128) { this.status = value; this.pending = [value]; if (value === 246) { this.pending = []; this.status = null; return [[value]]; } return []; }
    if (this.status === null) return [];
    if (!this.pending.length) this.pending.push(this.status);
    this.pending.push(value); if (this.pending.length > 16384) { this.pending = []; this.status = null; throw Error('MIDI message too large'); }
    if (this.status === 240) return [];
    const length = [12, 13].includes(this.status >> 4) || [241, 243].includes(this.status) ? 2 : 3;
    if (this.pending.length !== length) return [];
    const message = this.pending; this.pending = []; if (this.status >= 240) this.status = null; return [message];
  }
}
export function midiPackets(data, cable = 2) {
  if (!data.length) return new Uint8Array();
  if (data[0] === 240) {
    if (data.at(-1) !== 247 || data.slice(1, -1).some(b => b >= 128)) throw Error('Malformed SysEx');
    const out = [];
    for (let i = 0; i < data.length; i += 3) { const chunk = [...data.slice(i, i + 3)]; out.push(cable << 4 | (i + 3 < data.length ? 4 : 4 + chunk.length), ...chunk, ...Array(3 - chunk.length).fill(0)); }
    return Uint8Array.from(out);
  }
  const s = data[0], cin = s < 240 ? s >> 4 : ({241: 2, 242: 3, 243: 2, 246: 5})[s] ?? 15;
  const n = ({2: 2, 3: 3, 5: 1, 8: 3, 9: 3, 10: 3, 11: 3, 12: 2, 13: 2, 14: 3, 15: 1})[cin];
  if (s < 128 || [244, 245, 247, 249, 253].includes(s) || data.length !== n || data.slice(1).some(b => b >= 128)) throw Error('Malformed MIDI message');
  return Uint8Array.of(cable << 4 | cin, ...data, ...Array(3 - data.length).fill(0));
}
export function packetBytes(data) {
  if (data.length % 4) throw Error('Incomplete USB MIDI packet');
  const out = [], lengths = {2: 2, 3: 3, 4: 3, 5: 1, 6: 2, 7: 3, 8: 3, 9: 3, 10: 3, 11: 3, 12: 2, 13: 2, 14: 3, 15: 1};
  for (let i = 0; i < data.length; i += 4) { if (data.slice(i, i + 4).every(b => b === 0)) continue;
    const n = lengths[data[i] & 15]; if (!n) throw Error('Unsupported USB MIDI CIN'); out.push([data[i] >> 4, data.slice(i + 1, i + 1 + n)]); }
  return out;
}
