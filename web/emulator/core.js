import {CriticalMonitor} from './critical.js';
import {Board} from './board.js';
import {Interrupts} from './interrupts.js';
import {WasmBridge} from './bridge.js';
import {Debugger} from './debug.js';
export class Memory {
  constructor(module, engine) { this.u = module; this.e = engine; this.handle = module.getValue(engine.handle_ptr, '*'); this.regions = []; this.pages = new Map(); }
  map(base, size) {
    const ptr = this.u._malloc(size); if (!ptr) throw Error('Emulator memory allocation failed');
    const error = this.u._uc_mem_map_ptr(this.handle, BigInt(base), BigInt(size), 7, ptr);
    if (error) { this.u._free(ptr); throw Error(`Cannot map emulator memory: ${error}`); }
    const region = {base, size, ptr}; this.regions.push(region);
    for (let page = base >>> 16; page <= (base + size - 1) >>> 16; page++) this.pages.set(page, region);
    this.u.HEAPU8.fill(0, ptr, ptr + size);
  }
  pointer(a, n) { const r = this.pages.get(a >>> 16); if (!r || a < r.base || a + n > r.base + r.size) throw Error(`Unmapped memory 0x${a.toString(16)}`); return r.ptr + a - r.base; }
  get(a, n = 4) {
    const p = this.pointer(a, n);
    if (n === 1) return this.u.HEAPU8[p];
    if (n === 2 && !(p & 1)) return this.u.HEAPU16[p >>> 1];
    if (n === 4 && !(p & 3)) return this.u.HEAPU32[p >>> 2];
    if (n !== 2 && n !== 4) throw Error('Unsupported memory width');
    let value = 0; for (let i = 0; i < n; i++) value |= this.u.HEAPU8[p + i] << (i * 8); return value >>> 0;
  }
  put(a, v, n = 4) {
    const p = this.pointer(a, n);
    if (n === 1) this.u.HEAPU8[p] = v;
    else if (n === 2 && !(p & 1)) this.u.HEAPU16[p >>> 1] = v;
    else if (n === 4 && !(p & 3)) this.u.HEAPU32[p >>> 2] = v;
    else { if (n !== 2 && n !== 4) throw Error('Unsupported memory width'); for (let i = 0; i < n; i++) this.u.HEAPU8[p + i] = v >>> (i * 8); }
  }
  read(a, n) { const p = this.pointer(a, n); return this.u.HEAPU8.slice(p, p + n); }
  write(a, data) { this.u.HEAPU8.set(data, this.pointer(a, data.length)); }
  close() { for (const r of this.regions) this.u._free(r.ptr); this.regions = []; this.pages.clear(); }
}
export class Machine {
  constructor(module, image, options = {}) {
    this.u = module; this.image = image; this.error = null; this.hooks = []; this.events = []; this.eventIndex = 0;
    this.engine = new module.Unicorn(module.ARCH_ARM, module.MODE_THUMB | module.MODE_MCLASS);
    this.engine.ctl_set_cpu_model(module.CPU_ARM_CORTEX_M7);
    this.mem = new Memory(module, this.engine); this.scratch = module._malloc(4); this.handle = module.getValue(this.engine.handle_ptr, '*');
    for (const [base, size] of [[0, 0x4000], [0x200000, 65536], [0x8000000, 65536], [0x20000000, 0x40000], [0x40000000, 0x80000], [0x50000000, 0x40000], [0xe000e000, 0x2000]]) this.mem.map(base, size);
    for (const s of image.segments) { this.mem.write(s.address, s.data); if (s.address >= 0x200000 && s.address < 0x210000) this.mem.write(s.address + 0x7e00000, s.data); }
    for (const base of [0x200000, 0x8000000]) this.engine.mem_protect(base, 65536, module.PROT_READ | module.PROT_EXEC);
    this.setReg('MSP', image.stack); this.setReg('PC', image.reset); this.setReg('XPSR', 0x01000000); this.mem.put(0xe000ed08, 0x200000);
    this.critical = new CriticalMonitor(image.loadedImageSha256 || image.sha256);
    this.board = new Board(this.mem, image, {...options, critical: this.critical}); this.irq = new Interrupts(this); this.board.irq = this.irq;
    this.debug = new Debugger(this); this.execution = options.execution; this.executionHooks = [];
    this.debug.configure(options.debug);
    const guard = f => (...a) => { if (this.error) return; try { f(...a); } catch (e) { this.fail(e); } };
    const instruction = pc => this.irq.instruction(pc);
    const read = (a, n) => { this.alignment(a, n); if (a >= 0x40000000) { this.board.read(a, n); this.irq.read(a, n); } };
    const write = (a, n, v) => {
      this.critical.memory(a, n, v);
      this.alignment(a, n);
      if (a >= 0x200000 && a < 0x210000) throw Error('Write to flash execution alias');
      if (a >= 0x40000000 || a >= 0x8000000 && a < 0x8010000) { this.irq.write(a, n, v); this.board.write(a, n, v); }
    };
    this.executionCallbacks = {guard, instruction, read, write};
    this.installExecution();
    this.hooks.push(this.engine.hook_add(module.HOOK_MEM_WRITE_UNMAPPED | module.HOOK_MEM_WRITE_PROT, (e, t, addr, n, value) => { try { this.critical.memory(Number(addr), n, Number(value)); } catch (error) { this.fail(error); } return false; }));
    this.hooks.push(this.engine.hook_add(module.HOOK_INTR, guard((e, n) => { this.bridge?.flush(); this.irq.exception(n); this.bridge?.configure(); })));
  }
  installExecution() {
    this.bridge?.flush(); this.bridge?.close(); this.bridge = null;
    for (const h of this.executionHooks) this.engine.hook_del(h);
    this.executionHooks = [];
    const module = this.u, {guard, instruction, read, write} = this.executionCallbacks;
    if (!this.debug.enabled && this.execution !== 'scalar' && module._sq64_bridge_new) this.bridge = new WasmBridge(this, instruction, read, write);
    else {
      this.executionHooks.push(this.engine.hook_add(module.HOOK_CODE, guard((e, addr, size) => {
        if (this.board.poweredOff) { this.engine.emu_stop(); return; }
        if (this.debug.enabled && this.debug.instruction(Number(addr), size)) return;
        this.board.advance();
        while (this.eventIndex < this.events.length && this.events[this.eventIndex].tick <= this.board.ticks) this.event(this.events[this.eventIndex++]);
        instruction(Number(addr));
      })));
      this.executionHooks.push(this.engine.hook_add(module.HOOK_MEM_READ, guard((e, t, addr, n) => read(Number(addr), n))));
      this.executionHooks.push(this.engine.hook_add(module.HOOK_MEM_WRITE, guard((e, t, addr, n, value) => write(Number(addr), n, Number(value) >>> 0))));
    }
  }
  configureDebug(options) {
    const enabled = this.debug.enabled;
    this.debug.configure(options);
    if (enabled !== this.debug.enabled) this.installExecution();
    return this.debug.report();
  }
  reg(name) { const code = this.u._uc_reg_read(this.handle, this.u['ARM_REG_' + name], this.scratch); if (code) throw Error(`Register read ${name}: ${code}`); return this.u.getValue(this.scratch, 'i32') >>> 0; }
  setReg(name, value) { this.u.setValue(this.scratch, value, 'i32'); const code = this.u._uc_reg_write(this.handle, this.u['ARM_REG_' + name], this.scratch); if (code) throw Error(`Register write ${name}: ${code}`); }
  fail(error) { this.error ||= String(error.message || error); this.engine.emu_stop(); }
  alignment(a, n) {
    if (n <= 1 || a % Math.min(n, 4) === 0) return;
    const pc = this.reg('PC'), op = this.mem.get(pc, 2);
    const scalar = (op & 0xe000) === 0x6000 || (op & 0xf000) === 0x8000 || (op & 0xf000) === 0x5000 || (op & 0xfe00) === 0xf800;
    if (scalar && a < 0x40000000 && !(this.mem.get(0xe000ed14) & 8)) return;
    throw Error(`Cortex-M alignment fault: PC=0x${pc.toString(16)}, address=0x${a.toString(16)}`);
  }
  event(event) {
    if (event.type === 'power' && typeof event.down === 'boolean') { this.board.powerButton = event.down; this.board.panel.events.push({...event, tick: this.board.ticks}); }
    else if (event.type === 'midi') { if (!Array.isArray(event.data) || !event.data.every(b => Number.isInteger(b) && b >= 0 && b <= 255)) throw Error('Invalid MIDI bytes'); this.board.injectMidi(event.data, event.port); }
    else this.board.panel.event(event, this.board.ticks);
  }
  replay(events) {
    if (!Array.isArray(events) || events.length > 100000) throw Error('Invalid replay'); let last = this.board.ticks;
    for (const e of events) { if (!Number.isInteger(e.tick) || e.tick < last) throw Error('Replay must be ordered and in the future'); last = e.tick; }
    this.events = structuredClone(events); this.eventIndex = 0;
  }
  queueEvent(event, tick) {
    if (tick <= this.board.ticks) return this.event(event);
    if (this.eventIndex) { this.events = this.events.slice(this.eventIndex); this.eventIndex = 0; }
    if (this.events.length >= 100000) throw Error('Input queue full');
    const index = this.events.findIndex(e => e.tick > tick);
    this.events.splice(index < 0 ? this.events.length : index, 0, {...event, tick});
  }
  run(count = 10000) {
    if (!Number.isInteger(count) || count < 1 || count > 10000000) throw Error('Invalid instruction budget');
    if (this.critical.hit && !this.error) this.fail(this.critical.report().warning);
    if (this.debug.enabled) this.debug.beginRun();
    if (!this.error && !this.board.poweredOff) try { this.bridge?.prepare(count); this.engine.emu_start(this.reg('PC') | 1, 0xffffffff, 0, this.bridge ? 0 : count); } catch (e) { this.fail(e); } finally { try { this.bridge?.flush(); } catch (e) { this.fail(e); } }
    return this.report();
  }
  report() { return {format: 'sq64-emulator-report', version: 1, engine: 'unicorn-wasm-2.1.4-tci-itstate', imageSha256: this.image.sha256, critical: this.critical.report(), status: this.critical.hit ? 'terminated' : this.error ? 'fault' : this.debug.stoppedAt !== null ? 'breakpoint' : 'paused', error: this.error, pc: this.reg('PC'), sp: this.reg('SP'), debug: this.debug.report(), board: this.board.report(), interrupts: this.irq.report(), hardwareConformance: 'not-established'}; }
  close() { this.bridge?.close(); for (const h of [...this.hooks, ...this.executionHooks]) this.engine.hook_del(h); this.engine.close(); this.mem.close(); this.u._free(this.scratch); this.u._free(this.engine.handle_ptr); }
}
