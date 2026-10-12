/* Architectural host model; contains no device firmware implementation. */
export class Interrupts {
  constructor(machine) { this.m = machine; this.enabled = 0n; this.pending = 0n; this.active = []; this.trace = []; this.delivered = 0; this.scheduled = 0; this.itSlots = new Map(); }
  pend(irq) { this.pending |= 1n << BigInt(irq); this.scheduled++; }
  write(a, n, value) {
    for (const [base, field, clear] of [[0xe000e100, 'enabled', false], [0xe000e180, 'enabled', true], [0xe000e200, 'pending', false], [0xe000e280, 'pending', true]]) {
      if (a >= base && a + n <= base + 12) { const bits = BigInt(value) << BigInt((a - base) * 8); this[field] = clear ? this[field] & ~bits : this[field] | bits; return; }
    }
    if (a === 0xe000ef00) { if (n !== 4 || value >= 96) throw Error('Invalid STIR'); this.pend(value); }
  }
  read(a, n) {
    if (a < 0xe000e100 || a >= 0xe000e30c) return;
    const active = this.active.reduce((b, f) => b | 1n << BigInt(f.irq), 0n);
    for (const [base, value] of [[0xe000e100, this.enabled], [0xe000e180, this.enabled], [0xe000e200, this.pending], [0xe000e280, this.pending], [0xe000e300, active]]) {
      if (a >= base && a + n <= base + 12) { this.m.mem.put(a, Number(value >> BigInt((a - base) * 8) & ((1n << BigInt(n * 8)) - 1n)), n); return; }
    }
  }
  priority(irq) { return this.m.mem.get(0xe000e400 + irq, 1) & 240; }
  eligible() {
    const m = this.m; if (m.reg('PRIMASK') || m.reg('FAULTMASK')) return null;
    if (m.mem.get(0xe000ed0c) & 0x700) throw Error('Unsupported NVIC priority grouping');
    let ceiling = this.active.length ? this.priority(this.active.at(-1).irq) : 256, selected = null;
    const basepri = m.reg('BASEPRI') & 240; if (basepri) ceiling = Math.min(ceiling, basepri);
    const bits = this.pending & this.enabled;
    for (let irq = 0; irq < 96; irq++) if (bits & 1n << BigInt(irq) && this.priority(irq) < ceiling) { ceiling = this.priority(irq); selected = irq; }
    return selected;
  }
  enter(irq, pc) {
    const m = this.m, control = m.reg('CONTROL'), xpsr = m.reg('XPSR'), extended = !!(control & 4), fpccr = m.mem.get(0xe000ef34), lazy = extended && !!(fpccr & 0x40000000);
    if (this.itSlots.has(pc) && (((xpsr >>> 25 & 3) | (xpsr >>> 8 & 252)) !== this.itSlots.get(pc))) throw Error('CPU engine does not preserve IT preemption state');
    if (extended && !(fpccr & 0x80000000)) throw Error('Unsupported FP preservation mode');
    if ((xpsr & 511) !== (this.active.length ? this.active.at(-1).irq + 16 : 0)) throw Error('Unexpected exception context');
    const handler = m.mem.get(m.mem.get(0xe000ed08) + (irq + 16) * 4); if (!(handler & 1)) throw Error('IRQ vector is not Thumb code');
    const psp = !this.active.length && !!(control & 2), bank = psp ? 'PSP' : 'MSP', sp = m.reg(bank), padding = !!(m.mem.get(0xe000ed14) & 512 && sp & 4), size = extended ? 104 : 32;
    if (sp % 4) throw Error('Unaligned exception stack');
    const at = sp - size - (padding ? 4 : 0), values = ['R0', 'R1', 'R2', 'R3', 'R12', 'LR'].map(r => m.reg(r));
    values.push(pc, (xpsr & ~512) | (padding ? 512 : 0)); values.forEach((v, i) => m.mem.put(at + i * 4, v));
    let token = psp ? 0xfffffffd : this.active.length ? 0xfffffff1 : 0xfffffff9; if (extended) token &= ~16;
    const frame = {irq, at, bank, size, control, extended, lazy, saved: extended && !lazy, fpccr, token: token >>> 0};
    if (extended) { if (lazy) { m.mem.put(0xe000ef34, fpccr | 1); m.mem.put(0xe000ef38, at + 32); } else this.saveFp(frame); }
    this.active.push(frame); this.pending &= ~(1n << BigInt(irq)); m.setReg(bank, at); m.setReg('PC', handler);
    m.setReg('XPSR_NZCVQG', (xpsr & ~0x0600ffff) | 0x01000000 | (irq + 16)); m.setReg('CONTROL', control & ~4); m.setReg('LR', token);
    this.delivered++; this.record(['enter', irq, this.active.length]);
  }
  saveFp(frame) { for (let i = 0; i < 16; i++) this.m.mem.put(frame.at + 32 + i * 4, this.m.reg('S' + i)); this.m.mem.put(frame.at + 96, this.m.reg('FPSCR')); frame.saved = true; }
  instruction(pc) {
    const m = this.m, op = m.mem.get(pc, 2);
    if ((op & 0xff00) === 0xbf00 && (op & 15) && (op >>> 4 & 15) < 14) {
      let state = op & 255, at = pc + 2;
      for (let i = 0; state && i < 4; i++) { this.itSlots.set(at, state); const next = m.mem.get(at, 2); at += (next >>> 11) >= 29 ? 4 : 2; state = state & 7 ? (state & 224) | (state << 1 & 31) : 0; }
    }
    // Disabled pending sources must remain pending, but cannot preempt the CPU.
    const irq = (this.pending & this.enabled) ? this.eligible() : null;
    if (irq !== null) this.enter(irq, pc);
    else if (this.active.length && (op & 0xec00) === 0xec00) {
      for (const frame of this.active) if (frame.lazy && !frame.saved) this.saveFp(frame);
      const fp = m.mem.get(0xe000ef34); m.mem.put(0xe000ef34, fp & ~1); if (fp & 0x80000000) m.setReg('CONTROL', m.reg('CONTROL') | 4);
    }
  }
  exception(number) {
    const m = this.m, frame = this.active.at(-1);
    if (number !== 8 || !frame) throw Error(`Unhandled CPU exception ${number}`);
    if (((m.reg('PC') | 1) >>> 0) !== frame.token || m.reg(frame.bank) !== frame.at) throw Error('Invalid exception return');
    const values = Array.from({length: 8}, (_, i) => m.mem.get(frame.at + i * 4)), xpsr = values[7];
    const ipsr = this.active.length > 1 ? this.active.at(-2).irq + 16 : 0;
    if (!(xpsr & 0x01000000) || (xpsr & 511) !== ipsr) throw Error('Invalid stacked state');
    ['R0', 'R1', 'R2', 'R3', 'R12', 'LR'].forEach((r, i) => m.setReg(r, values[i]));
    if (frame.extended) { if (frame.saved) { for (let i = 0; i < 16; i++) m.setReg('S' + i, m.mem.get(frame.at + 32 + i * 4)); m.setReg('FPSCR', m.mem.get(frame.at + 96)); } else if (!(m.mem.get(0xe000ef34) & 1)) throw Error('Unexpected lazy FP state'); m.mem.put(0xe000ef34, frame.fpccr); }
    m.setReg(frame.bank, frame.at + frame.size + (xpsr & 512 ? 4 : 0)); this.active.pop();
    m.setReg('PC', values[6] | 1); m.setReg('XPSR_NZCVQG', xpsr & ~512); m.setReg('CONTROL', frame.control); this.record(['return', frame.irq, this.active.length]);
  }
  record(row) { this.trace.push(row); if (this.trace.length > 256) this.trace.shift(); }
  report() { return {delivered: this.delivered, scheduled: this.scheduled, enabled: '0x' + this.enabled.toString(16), pending: '0x' + this.pending.toString(16), active: this.active.map(f => f.irq), trace: this.trace}; }
}
