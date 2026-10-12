import {midiPackets, packetBytes} from './midi.js';
export class UsbDevice {
  constructor(board) {
    this.board = board; this.regs = new Map(); this.rx = []; this.fifo = []; this.tx = new Map(); this.expected = new Map();
    this.ins = new Map(); this.outs = new Map(); this.global = 0; this.phase = 'disconnected'; this.setupActive = null; this.config = []; this.pending = []; this.bulkOut = 1; this.resetRecovery = 0; this.lastSof = 0; this.frame = 0;
  }
  reg(o) { return this.regs.get(o) ?? (o === 0x804 ? 2 : 0); }
  inStatus(ep) { return (this.ins.get(ep) || 0) | ((this.expected.get(ep) || 0) > (this.tx.get(ep)?.length || 0) ? 128 : 0); }
  status() {
    let value = this.global | (this.rx.length ? 16 : 0);
    for (let ep = 0; ep < 6; ep++) {
      if ((this.reg(0x81c) & 1 << ep) && (this.inStatus(ep) & (this.reg(0x810) | (this.reg(0x834) & 1 << ep ? 128 : 0)))) value |= 1 << 18;
      if ((this.reg(0x81c) & 1 << (16 + ep)) && ((this.outs.get(ep) || 0) & this.reg(0x814))) value |= 1 << 19;
    }
    return value >>> 0;
  }
  signal() { if (this.reg(8) & 1 && this.status() & this.reg(0x18)) this.board.pend(67); }
  read(o) {
    if (o === 0x10) return 0x80000000;
    if (o === 0x14) return this.status();
    if ([0x1c, 0x20].includes(o)) {
      if (!this.rx.length) return 0;
      const [ep, kind, payload] = o === 0x1c ? this.rx[0] : this.rx.shift();
      if (o === 0x20) for (let i = 0; i < payload.length; i += 4) this.fifo.push(((payload[i] || 0) | (payload[i + 1] || 0) << 8 | (payload[i + 2] || 0) << 16 | (payload[i + 3] || 0) << 24) >>> 0);
      return ep | payload.length << 4 | kind << 17;
    }
    if (o === 0x818) { let v = 0; for (let ep = 0; ep < 6; ep++) { if (this.inStatus(ep)) v |= 1 << ep; if (this.outs.get(ep)) v |= 1 << (16 + ep); } return v; }
    if (o === 0x808) return 6 | (this.frame & 2047) << 8;
    if (o >= 0x900 && o < 0xa00 && o % 32 === 8) return this.inStatus((o - 0x900) / 32 | 0);
    if (o >= 0xb00 && o < 0xc00 && o % 32 === 8) return this.outs.get((o - 0xb00) / 32 | 0) || 0;
    if (o >= 0x900 && o < 0xa00 && o % 32 === 24) return 1024;
    if (o >= 0x1000) { if (o !== 0x1000 || !this.fifo.length) throw Error('USB RX FIFO underflow'); return this.fifo.shift(); }
    return this.reg(o);
  }
  write(o, value) {
    if (o === 0x14) { this.global &= ~value; this.signal(); return; }
    if (o >= 0x900 && o < 0xa00 && o % 32 === 8) { const ep = (o - 0x900) / 32 | 0; this.ins.set(ep, (this.ins.get(ep) || 0) & ~value); return; }
    if (o >= 0xb00 && o < 0xc00 && o % 32 === 8) { const ep = (o - 0xb00) / 32 | 0; this.outs.set(ep, (this.outs.get(ep) || 0) & ~value); return; }
    if (o === 0x804 && (this.reg(o) & 2) && !(value & 2)) {
      this.phase = 'disconnected'; this.setupActive = null; this.config = [];
      this.lastSof = this.board.cycles; this.frame = 0;
    }
    this.regs.set(o, value);
    if (o >= 0x900 && o < 0xa00 && o % 32 === 16) { const ep = (o - 0x900) / 32 | 0; this.expected.set(ep, value & 0x7ffff); this.tx.set(ep, []); }
    if (o >= 0x900 && o < 0xa00 && o % 32 === 0 && value & 0x80000000) { const ep = (o - 0x900) / 32 | 0; if (this.expected.get(ep) === 0) this.finishIn(ep); }
    if (o >= 0x1000) {
      const ep = (o - 0x1000) / 0x1000 | 0; if (o % 0x1000 || ep > 5) throw Error('Unsupported USB FIFO');
      if (!this.tx.has(ep)) this.tx.set(ep, []);
      this.tx.get(ep).push(value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24);
      if (this.expected.has(ep) && this.tx.get(ep).length >= this.expected.get(ep)) this.finishIn(ep);
    }
  }
  finishIn(ep) {
    const data = (this.tx.get(ep) || []).slice(0, this.expected.get(ep) || 0);
    this.ins.set(ep, (this.ins.get(ep) || 0) | 1);
    if (ep === 0) {
      let complete = true;
      if (this.setupActive?.[1] === 6 && this.setupActive[3] === 2) {
        this.config.push(...data); let expected = this.setupActive[6] | this.setupActive[7] << 8;
        if (this.config.length >= 4) expected = Math.min(expected, this.config[2] | this.config[3] << 8);
        complete = data.length < 64 || this.config.length >= expected;
      }
      if (complete && (this.setupActive?.[0] & 128)) { this.rx.push([0, 2, []], [0, 3, []]); this.outs.set(0, (this.outs.get(0) || 0) | 1); }
      if (complete) this.setupActive = null;
    } else for (const [cable, payload] of packetBytes(data)) for (const byte of payload) this.board.emitMidi(byte, 'usb', cable);
    this.tx.set(ep, []); this.expected.delete(ep); this.signal();
  }
  setup(payload) { this.setupActive = payload; this.rx.push([0, 6, payload], [0, 4, []]); this.outs.set(0, (this.outs.get(0) || 0) | 8); this.signal(); }
  service() {
    if (this.reg(0x804) & 2) return;
    if (!['disconnected', 'reset'].includes(this.phase) && this.board.cycles - this.lastSof >= 216000) {
      const elapsed = Math.floor((this.board.cycles - this.lastSof) / 216000);
      this.frame = (this.frame + elapsed) & 2047; this.lastSof += elapsed * 216000; this.global |= 8;
      // A host polls a configured bulk IN pipe even while it NAKs. The
      // controller reports IN-token/TX-FIFO-empty independently of DAINTMSK.
      if (this.phase === 'configured' && (this.reg(0x920) & 0x8000)) this.ins.set(1, (this.ins.get(1) || 0) | 16);
    }
    if (this.phase === 'disconnected' && this.reg(0x18) & 1 << 12) { this.global |= 1 << 12; this.phase = 'reset'; }
    else if (this.phase === 'reset' && !(this.global & 1 << 12)) {
      this.global |= 1 << 13; this.phase = 'enumeration';
      this.resetRecovery = this.board.cycles + 2160000; // Nominal 10 ms at 216 MHz.
    }
    // ENUMDNE is a controller notification, not a USB handshake. Firmware may
    // leave it masked; the host still sends SETUP after reset recovery.
    else if (this.phase === 'enumeration' && this.board.cycles >= this.resetRecovery) { this.setup([0, 5, 1, 0, 0, 0, 0, 0]); this.phase = 'address'; }
    else if (this.phase === 'address' && !this.setupActive) { this.setup([128, 6, 0, 2, 0, 0, 255, 0]); this.phase = 'descriptors'; }
    else if (this.phase === 'descriptors' && !this.setupActive) {
      for (let o = 0; o + 2 <= this.config.length;) {
        const size = this.config[o]; if (size < 2 || o + size > this.config.length) break;
        if (this.config[o + 1] === 5 && size >= 7 && (this.config[o + 3] & 3) === 2 && !(this.config[o + 2] & 128)) this.bulkOut = this.config[o + 2] & 15;
        o += size;
      }
      this.setup([0, 9, 1, 0, 0, 0, 0, 0]); this.phase = 'configure';
    } else if (this.phase === 'configure' && !this.setupActive) this.phase = 'configured';
    if (this.phase === 'configured' && this.pending.length && !this.rx.length && !this.fifo.length && (this.reg(0xb00 + this.bulkOut * 32) & 0x8000) && !(this.reg(0xb00 + this.bulkOut * 32) & 0x220000)) {
      this.rx.push([this.bulkOut, 2, this.pending.shift()], [this.bulkOut, 3, []]); this.outs.set(this.bulkOut, (this.outs.get(this.bulkOut) || 0) | 1);
    }
    this.signal();
  }
  inject(message) {
    const data = midiPackets(message); if (this.pending.length + Math.ceil(data.length / 64) > 1024) throw Error('USB receive queue full');
    for (let i = 0; i < data.length; i += 64) this.pending.push(data.slice(i, i + 64));
  }
}
