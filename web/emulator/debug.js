// Opt-in CPU diagnostics. Inspection never invokes peripheral reads.
export const REGISTERS = [...Array.from({length: 13}, (_, i) => `R${i}`), 'SP', 'LR', 'PC', 'XPSR', 'MSP', 'PSP', 'CONTROL', 'PRIMASK', 'BASEPRI', 'FAULTMASK'];
export function address(value) {
  if (typeof value === 'string' && /^(0x[\da-f]+|\d+)$/i.test(value.trim())) value = Number(value);
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw Error('Enter a 32-bit address (decimal or 0x hexadecimal)');
  return value;
}
export class Debugger {
  constructor(machine) { this.m = machine; this.enabled = false; this.breakpoints = new Set(); this.traceLimit = 256; this.trace = []; this.stoppedAt = null; this.skip = null; }
  configure({enabled = this.enabled, breakpoints = [...this.breakpoints], traceLimit = this.traceLimit} = {}) {
    if (typeof enabled !== 'boolean') throw Error('Debug enabled must be a boolean');
    if (!Array.isArray(breakpoints) || breakpoints.length > 64) throw Error('Use at most 64 breakpoints');
    const points = breakpoints.map(value => {
      const pc = address(value) & ~1;
      this.m.mem.pointer(pc >>> 0, 2);
      if (pc < 0 || pc >= 0x40000000) throw Error('Breakpoint must be in mapped code memory');
      return pc;
    });
    if (!Number.isInteger(traceLimit) || traceLimit < 0 || traceLimit > 4096) throw Error('Trace limit must be 0..4096');
    this.enabled = enabled; this.breakpoints = new Set(points); this.traceLimit = traceLimit;
    this.trace = enabled && traceLimit ? this.trace.slice(-traceLimit) : [];
    if (!enabled) this.stoppedAt = this.skip = null;
  }
  config() { return {enabled: this.enabled, breakpoints: [...this.breakpoints].sort((a, b) => a - b), traceLimit: this.traceLimit}; }
  beginRun() { this.skip = this.stoppedAt === this.m.reg('PC') ? this.stoppedAt : null; this.stoppedAt = null; }
  instruction(pc, size) {
    const skip = this.skip === pc; this.skip = null;
    if (!skip && this.breakpoints.has(pc)) { this.stoppedAt = pc; this.m.engine.emu_stop(); return true; }
    if (this.traceLimit) {
      this.trace.push({tick: this.m.board.ticks, pc, bytes: Array.from(this.m.mem.read(pc, size))});
      if (this.trace.length > this.traceLimit) this.trace.shift();
    }
    return false;
  }
  memory(at, length = 128) {
    if (!this.enabled) throw Error('Enable debugging first');
    at = address(at);
    if (!Number.isInteger(length) || length < 1 || length > 4096) throw Error('Memory length must be 1..4096');
    if (at + length > 0x40000000) throw Error('Inspection supports code and RAM only; use the execution report for peripherals');
    return {address: at, bytes: Array.from(this.m.mem.read(at, length))};
  }
  report() {
    if (!this.enabled) return {enabled: false};
    return {...this.config(), stoppedAt: this.stoppedAt, registers: Object.fromEntries(REGISTERS.map(r => [r, this.m.reg(r)])), trace: this.trace.slice()};
  }
}
