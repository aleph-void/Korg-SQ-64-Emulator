// Shared bridge ABI is declared in tools/wasm_bridge.c. Never retain heap views
// across calls: Unicorn can grow its WebAssembly memory while translating code.
export class WasmBridge {
  constructor(machine, instruction, read, write) {
    this.m = machine;
    this.callback = machine.u.addFunction((kind, address, size, value) => {
      if (machine.error) return;
      try {
        address >>>= 0;
        this.flush();
        if (kind === 0) instruction(address);
        else if (kind === 1) read(address, size);
        else write(address, size, value >>> 0);
        this.configure();
        if (kind === 2 && (address >= 0xe000e400 && address < 0xe000e460 || address === 0xe000ed0c)) machine.u.HEAPU32[(this.pointer >>> 2) + 1] = 1;
      } catch (error) { machine.fail(error); }
    }, 'viiii');
    this.pointer = machine.u._sq64_bridge_new(machine.handle, this.callback);
    if (!this.pointer) { machine.u.removeFunction(this.callback); throw Error('Cannot create execution bridge'); }
    const heap = machine.u.HEAPU32, at = this.pointer >>> 2;
    for (const [index, base] of [0,0x200000,0x8000000,0x20000000].entries()) heap[at + 5 + index] = machine.mem.pointer(base, 2);
    this.configure();
  }
  flush() {
    const m = this.m, heap = m.u.HEAPU32, at = this.pointer >>> 2, elapsed = heap[at];
    if (!elapsed) return;
    heap[at] = 0; m.board.advance(elapsed);
    while (m.eventIndex < m.events.length && m.events[m.eventIndex].tick <= m.board.ticks) m.event(m.events[m.eventIndex++]);
  }
  configure() {
    const m = this.m, b = m.board, at = this.pointer >>> 2;
    const timer = Math.max(1, Math.ceil((b.nextTimerCycle - b.cycles) / b.cyclesPerInstruction));
    const event = m.eventIndex < m.events.length ? Math.max(1, m.events[m.eventIndex].tick - b.ticks) : Infinity;
    // A pending source can become eligible on the very next CPU instruction
    // after CPS/MSR unmasks it. The native bridge checks those CPU masks.
    let priority = 256, ceiling = m.irq.active.length ? m.irq.priority(m.irq.active.at(-1).irq) : 256;
    let bits = m.irq.pending & m.irq.enabled;
    if (bits) {
      if (m.mem.get(0xe000ed0c) & 0x700) priority = 0;
      else for (let bank = 0; bank < 3; bank++) {
        let word = Number(bits >> BigInt(bank * 32) & 0xffffffffn);
        while (word) { const bit = 31 - Math.clz32(word & -word); word &= word - 1; priority = Math.min(priority, m.irq.priority(bank * 32 + bit)); }
      }
    }
    const heap = m.u.HEAPU32;
    heap[at + 1] = Math.min(0xffffffff, Math.max(1, b.nextServiceTick - b.ticks), timer, event);
    heap[at + 2] = m.irq.active.length; heap[at + 3] = Number(b.poweredOff);
    heap[at + 4] = priority < ceiling ? priority : 0xffffffff;
  }
  prepare(count) { this.m.u.HEAPU32[(this.pointer >>> 2) + 9] = count; this.configure(); }
  close() { this.m.u._sq64_bridge_free(this.pointer); this.m.u.removeFunction(this.callback); }
}
