import {SpiFlash} from './flash.js';
import {Panel} from './panel.js';
import {UsbDevice} from './usb.js';
import {MidiMessages} from './midi.js';
import {outputLevels} from './outputs.js';
export const TIMERS = new Map([[0x40000000, 28], [0x40000400, 29], [0x40000800, 30], [0x40000c00, 50], [0x40001000, 54], [0x40001400, 55], [0x40011400, 24]]);
const KNOWN_WINDOWS = [...TIMERS.keys()].map(a => [a, 0x80]).concat([[0x40003800, 0x800], [0x40004400, 0x800], [0x40007000, 0x800], [0x40010000, 0x100], [0x40012000, 0x400], [0x40013000, 0x5000], [0x40020000, 0x2400], [0x40023800, 0x800], [0x40026000, 0x800], [0xe000e000, 0x2000]]);
export class Board {
  constructor(memory, image, {mapping = {}, onMidi = () => {}, transport = 'usb', cyclesPerInstruction = 16, syncConnected = false, critical = null} = {}) {
    if (!Number.isInteger(cyclesPerInstruction) || cyclesPerInstruction < 1 || cyclesPerInstruction > 64) throw Error('Invalid virtual instruction timing');
    this.critical = critical; this.mem = memory; this.flash = new SpiFlash(image.spi, critical); this.panel = new Panel(mapping); this.usb = new UsbDevice(this);
    this.ticks = 0; this.cycles = 0; this.cyclesPerInstruction = cyclesPerInstruction; this.timers = new Set(); this.fraction = new Map(); this.dmaReload = new Map();
    this.flashRx = []; this.panelRx = []; this.scanPosition = 0; this.uartRx = new Map([[0x40004400, []], [0x40004800, []]]);
    this.powerButton = false; this.poweredOff = false; this.syncConnected = syncConnected;
    this.timerCycle = 0; this.nextTimerCycle = Infinity;
    this.nextServiceTick = 128;
    this.flashKey = 0; this.flashControl = 0x80000000; this.adc = 0xc000; this.lastPanelDma = 0; this.trace = []; this.midiOut = [];
    this.onMidi = onMidi; this.transport = transport; this.parsers = new Map();
    this.approximations = new Set(['instruction-time-clock', 'panel-electrical-timing', 'led-colorimetry', 'display-controller-commands', 'register-only-config-blocks', 'instantaneous-flash-completion', 'usb-fs-transaction-time']);
  }
  get(a, n = 4) { return this.mem.get(a, n); }
  outputLevels() { return outputLevels(this); }
  put(a, v, n = 4) { this.mem.put(a, v, n); }
  pend(n) { this.irq?.pend(n); }
  record(value) { this.trace.push(value); if (this.trace.length > 1024) this.trace.shift(); }
  advance(instructions = 1) {
    this.ticks += instructions; this.cycles += this.cyclesPerInstruction * instructions;
    if (this.cycles >= this.nextTimerCycle) this.syncTimers();
    if (this.ticks >= this.nextServiceTick) {
      this.completeDma(); this.usb.service(); this.scheduleService();
    }
  }
  wakeService() { this.nextServiceTick = Math.min(this.nextServiceTick, this.ticks + 128 - this.ticks % 128); }
  instructionTiming(cycles) {
    if (!Number.isInteger(cycles) || cycles < 1 || cycles > 64) throw Error('Invalid virtual instruction timing');
    this.syncTimers(); this.cyclesPerInstruction = cycles; this.wakeService();
  }
  scheduleService() {
    // Keep the original 128-instruction completion boundaries, but omit polls
    // that cannot complete a transfer. Register writes wake the next boundary.
    let delay = Infinity, tx = false, rx = false;
    for (let stream = 0; stream < 8; stream++) {
      const base = 0x40026010 + stream * 24, control = this.get(base);
      if (!(control & 1)) continue;
      if (this.get(base + 8) === 0x4000380c) {
        tx ||= (control >>> 6 & 3) === 1; rx ||= (control >>> 6 & 3) === 0;
      }
      if (base === 0x40026088 && this.get(base + 8) === 0x40003c0c) delay = 1;
    }
    if (tx && rx || !(this.usb.reg(0x804) & 2)) delay = 1;
    if (this.get(0x40026458) & this.get(0x40026440) & 1
        && this.get(0x40026460) === 0x4001300c && this.get(0x40026448) === 0x4001300c) {
      delay = Math.min(delay, Math.max(1, Math.ceil((this.lastPanelDma + this.panelTransferCycles() - this.cycles) / this.cyclesPerInstruction)));
    }
    this.nextServiceTick = Math.ceil((this.ticks + delay) / 128) * 128;
  }
  syncTimers() {
    // Advance only at an overflow or an observed timer-register access. IRQs
    // still become pending on the same instruction as in the scalar model.
    const elapsed = this.cycles - this.timerCycle; this.timerCycle = this.cycles;
    this.nextTimerCycle = Infinity;
    for (const base of this.timers) {
      const period = (this.get(base + 0x28) + 1) * this.timerClockDivider(base);
      const fraction = (this.fraction.get(base) || 0) + elapsed;
      const increment = Math.floor(fraction / period), remainder = fraction % period;
      this.fraction.set(base, remainder);
      let reload = this.get(base + 0x2c) + 1; if (reload === 1) reload = 65536;
      let count = this.get(base + 0x24);
      if (increment) {
        count += increment;
        if (count >= reload) { const status = this.get(base + 0x10); this.put(base + 0x10, status | 1); if (this.get(base + 12) & 1 && !(status & 1)) this.pend(TIMERS.get(base)); }
        count %= reload; this.put(base + 0x24, count);
      }
      this.nextTimerCycle = Math.min(this.nextTimerCycle, this.cycles + Math.max(1, (reload - count) * period - remainder));
    }
  }
  timerClockDivider(base) {
    const prescaler = this.get(0x40023808) >>> (base >= 0x40010000 ? 13 : 10) & 7;
    const apb = prescaler < 4 ? 1 : 1 << (prescaler - 3);
    // STM32F7 RCC: divided APB domains clock timers at 2x PCLK, or
    // 4x PCLK/HCLK when TIMPRE is set. Cycles are measured in HCLK.
    return Math.max(1, apb / (this.get(0x4002388c) & 0x1000000 ? 4 : 2));
  }
  timerAddress(a) { return a >= 0x40000000 && a < 0x40001480 && (a & 0x3ff) < 0x80 || a >= 0x40011400 && a < 0x40011480; }
  emitMidi(byte, port, cable = 0) {
    byte &= 255; this.midiOut.push({tick: this.ticks, byte, port, cable}); if (this.midiOut.length > 256) this.midiOut.shift();
    if (this.transport === 'usb' ? port !== 'usb' || cable !== 1 : port !== 0x40004800) return;
    const key = `${port}/${cable}`; if (!this.parsers.has(key)) this.parsers.set(key, new MidiMessages());
    for (const message of this.parsers.get(key).feed(byte)) this.onMidi(Uint8Array.from(message));
  }
  injectMidi(data, port = this.transport) {
    if (port === 'usb') { this.usb.inject(data); return; }
    if (port === 'din') port = 0x40004800;
    const queue = this.uartRx.get(port); if (!queue || queue.length + data.length > 16384) throw Error('Invalid or full MIDI input queue');
    queue.push(...data); if (this.get(port + 12) & 32) this.pend(port === 0x40004800 ? 39 : 38);
  }
  known(a) {
    return KNOWN_WINDOWS.some(([b, n]) => a >= b && a < b + n);
  }
  write(a, n, v) {
    if (a >= 0x40026000 && a < 0x40026800
        || a < 0x4002380c && a + n > 0x40023808
        || a < 0x40013004 && a + n > 0x40013000
        || a >= 0x50000000 && a < 0x50006000) this.wakeService();
    this.critical?.memory(a, n, v); this.critical?.dmaWrite(a, n, v, address => this.get(address));
    if (this.timerAddress(a) || a === 0x40023808 || a === 0x4002388c) { this.syncTimers(); this.nextTimerCycle = this.cycles + this.cyclesPerInstruction; }
    if (TIMERS.has(a)) { if (v & 1) this.timers.add(a); else this.timers.delete(a); }
    if (a >= 0x50000000 && a < 0x50006000) { if (n !== 4) throw Error('USB requires word access'); this.usb.write(a - 0x50000000, v); return; }
    if (a >= 0x8000000 && a < 0x8010000) {
      if (n !== 4 || a % 4 || this.flashControl & 0x80000000 || !(this.flashControl & 1) || ((this.get(a) & v) >>> 0) !== v) throw Error('Invalid internal flash programming');
      this.put(a - 0x7e00000, v); return;
    }
    if (!this.known(a)) throw Error(`Unmodeled peripheral write at 0x${a.toString(16)}`);
    if (a === 0x40023c04) { if (this.flashKey === 0x45670123 && v === 0xcdef89ab) this.flashControl &= ~0x80000000; this.flashKey = v; }
    if (a === 0x40023c10) {
      this.flashControl = v;
      if ((v & 0x10002) === 0x10002) { const sector = v >>> 3 & 15; if (sector >= 4 || v & 0x80000000) throw Error('Unsupported flash erase'); for (const base of [0x200000, 0x8000000]) this.mem.write(base + sector * 16384, new Uint8Array(16384).fill(255)); this.flashControl &= ~0x10000; }
    }
    if (a === 0x40020418 && v & 0x800000 && this.get(0x40020414) & 128) this.poweredOff = true; // PB7 power-hold released by firmware
    for (let base = 0x40020000; base < 0x40022400; base += 1024) if (a === base + 24) this.put(base + 20, (this.get(base + 20) | (v & 65535)) & ~(v >>> 16));
    if (a === 0x40020418) { if (v & 0x02000000) this.flash.select(true); if (v & 512) this.flash.select(false); if (v & 0x10000) this.panel.latch(false); if (v & 1) this.panel.latch(true); }
    if (a === 0x4000380c) { if (![1, 2].includes(n)) throw Error('SPI word width'); for (let i = n - 1; i >= 0; i--) this.flashRx.push(this.flash.exchange(v >>> (i * 8) & 255)); }
    if (a === 0x4001300c) { if (n !== 1) throw Error('Panel polled SPI width'); this.panelRx.push(this.panel.exchange(v & 255)); }
    if (a === 0x40003c0c) this.record(['display-byte', v & 255]);
    for (const base of this.uartRx.keys()) if (a === base + 4) this.emitMidi(v, base);
    for (const controller of [0x40026000, 0x40026400]) {
      if ([controller + 8, controller + 12].includes(a)) this.put(a - 8, this.get(a - 8) & ~v);
      for (let s = 0; s < 8; s++) { const base = controller + 16 + s * 24;
        if (a === base + 4) this.dmaReload.set(base, v);
        if (a === base && v & 1 && !(this.get(base) & 1) && this.dmaReload.has(base)) this.put(base + 4, this.dmaReload.get(base));
      }
    }
  }
  read(a, n) {
    if (this.timerAddress(a)) this.syncTimers();
    if (a >= 0x50000000 && a < 0x50006000) { if (n !== 4) throw Error('USB word access required'); this.put(a, this.usb.read(a - 0x50000000)); return; }
    if (!this.known(a)) throw Error(`Unmodeled peripheral read at 0x${a.toString(16)}`);
    if (a === 0x40020810) this.put(a, this.get(a) & ~8192 | (this.powerButton ? 0 : 8192)); // PC13 active-low power button
    if (a === 0x40020410) this.put(a, this.get(a) & ~16 | (this.syncConnected ? 0 : 16)); // PB4: active-low sync jack detect
    if (a === 0x40020010) this.put(a, this.get(a) | 512); // USB VBUS input on PA9
    if (a === 0x40023800) { let v = this.get(a); for (const bit of [0, 16, 24, 26]) if (v & 1 << bit) v |= 1 << (bit + 1); this.put(a, v); }
    if (a === 0x40023808) { const v = this.get(a); this.put(a, v & ~12 | (v & 3) << 2); }
    if (a === 0x40007004) this.put(a, this.get(a) | 0x4000);
    if (a === 0x40012000 && this.get(0x40012008) & 0x40000000) { this.put(0x4001204c, this.adc); this.put(0x40012008, this.get(0x40012008) & ~0x40000000); this.put(a, this.get(a) | 2); }
    if (a === 0x40003808) { this.completeDma(); this.put(a, 2 | (this.flashRx.length ? 512 : 0), n); }
    if (a === 0x4000380c) { if (this.flashRx.length < n) throw Error('Flash FIFO underflow'); let v = 0; for (let i = 0; i < n; i++) v = v * 256 + this.flashRx.shift(); this.put(a, v, n); }
    if (a === 0x40013008) this.put(a, 2 | (this.panelRx.length ? 512 : 0), n);
    if (a === 0x4001300c) { if (n !== 1 || !this.panelRx.length) throw Error('Panel FIFO underflow'); this.put(a, this.panelRx.shift(), n); }
    if (a === 0x40003c08) this.put(a, 2, n);
    if (a === 0x40013c14) this.put(a, this.get(a) | 4);
    if (a === 0x40023c0c) this.put(a, 0); if (a === 0x40023c10) this.put(a, this.flashControl);
    for (const [base, queue] of this.uartRx) {
      if (a === base) this.put(a, 192 | (queue.length ? 32 : 0), n);
      if (a === base + 4) { if (!queue.length) throw Error('UART FIFO underflow'); this.put(a, queue.shift(), n); if (queue.length && this.get(base + 12) & 32) this.pend(base === 0x40004800 ? 39 : 38); }
    }
    if (a >= 0x40026000 && a < 0x40026800) this.completeDma();
  }
  transferDone(controller, stream, control) {
    const base = controller + 16 + stream * 24; this.put(base, control & ~1); this.put(base + 4, 0);
    const flag = [0, 6, 16, 22][stream % 4] + 5, status = controller + (stream >= 4 ? 4 : 0); this.put(status, this.get(status) | 1 << flag);
    if (control & 16) this.pend((controller === 0x40026000 ? [11, 12, 13, 14, 15, 16, 17, 47] : [56, 57, 58, 59, 60, 68, 69, 70])[stream]);
  }
  panelTransferCycles() {
    // One half-buffer is 64 bytes on SPI1 (APB2). Respect the configured
    // serial clock instead of scheduling an interrupt every 512 instructions.
    // Instruction timing itself remains approximate, as reported to callers.
    const apb = this.get(0x40023808) >>> 13 & 7;
    const apbDivider = apb < 4 ? 1 : 1 << (apb - 3);
    const spiDivider = 2 << (this.get(0x40013000) >>> 3 & 7);
    return 64 * 8 * apbDivider * spiDivider;
  }
  completeDma() {
    this.critical?.dma(address => this.get(address));
    const candidates = [];
    for (let s = 0; s < 8; s++) { const a = 0x40026010 + s * 24, c = this.get(a); if (c & 1 && this.get(a + 8) === 0x4000380c) candidates.push([a, s, c]); }
    const tx = candidates.find(r => (r[2] >>> 6 & 3) === 1), rx = candidates.find(r => (r[2] >>> 6 & 3) === 0);
    if (tx && rx) {
      const [ta, ts, tc] = tx, [ra, rs, rc] = rx, count = this.get(ta + 4), width = 1 << (tc >>> 13 & 3);
      if (count <= 0 || count > 4096 || count !== this.get(ra + 4) || ![1, 2].includes(width) || width !== 1 << (rc >>> 13 & 3)) throw Error('Unsupported flash DMA');
      const source = this.get(ta + 12), target = this.get(ra + 12);
      for (let i = 0; i < count; i++) { const v = this.get(source + (tc & 1024 ? i * width : 0), width); let response = 0; for (let j = width - 1; j >= 0; j--) response = response * 256 + this.flash.exchange(v >>> (j * 8) & 255); this.put(target + (rc & 1024 ? i * width : 0), response, width); }
      this.transferDone(0x40026000, ts, tc); this.transferDone(0x40026000, rs, rc); this.record(['flash-dma', count, width]);
    }
    const base = 0x40026088, control = this.get(base);
    if (control & 1 && this.get(base + 8) === 0x40003c0c) {
      if ((control >>> 6 & 3) !== 1 || (control >>> 13 & 3) !== 1 || !(control & 1024) || this.get(base + 4) !== 4096) throw Error('Unsupported display DMA');
      this.panel.frame(this.mem.read(this.get(base + 12), 8192)); this.transferDone(0x40026000, 5, control); this.record(['display-frame', this.panel.displayFrames]);
    }
    const ta = 0x40026458, ra = 0x40026440, tc = this.get(ta), rc = this.get(ra);
    if (tc & 1 && rc & 1 && this.get(ta + 8) === 0x4001300c && this.get(ra + 8) === 0x4001300c && this.cycles - this.lastPanelDma >= this.panelTransferCycles()) {
      this.approximations.add('panel-dma-scan-timing'); const count = this.get(ta + 4);
      if (!(tc & 256) || !(rc & 256) || (tc >>> 6 & 3) !== 1 || (rc >>> 6 & 3) || (tc | rc) & 0x7800 || ![64, 128].includes(count) || count !== this.get(ra + 4)) throw Error('Unsupported panel DMA');
      const offset = 128 - count, source = this.get(ta + 12) + offset, target = this.get(ra + 12) + offset;
      for (let i = 0; i < 64; i += 8) this.mem.write(target + i, this.panel.scanFrame(this.mem.read(source + i, 8)));
      this.put(ta + 4, count === 128 ? 64 : 128); this.put(ra + 4, count === 128 ? 64 : 128);
      this.put(0x40026400, this.get(0x40026400) | 1 << (count === 128 ? 26 : 27));
      if (tc & (count === 128 ? 8 : 16)) this.pend(59); this.lastPanelDma = this.cycles;
    }
  }
  report() { return {poweredOff: this.poweredOff, powerButton: this.powerButton, ticks: this.ticks, virtualCycles: this.cycles, approximations: [...this.approximations].sort(), flashWrites: this.flash.writes, trace: this.trace, midiOut: this.midiOut, usb: {phase: this.usb.phase, queuedPackets: this.usb.pending.length}}; }
}
