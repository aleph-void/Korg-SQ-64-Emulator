import test from 'node:test';
import assert from 'node:assert/strict';
import createUnicorn from '../vendor/unicorn-arm.js';
import {Machine} from '../emulator/core.js';
import {loadImage} from '../emulator/image.js';

const engine = await createUnicorn();
async function machine(code = [1, 0x30, 0xfd, 0xe7]) { // ADDS R0, #1; B back to ADDS.
  const data = new Uint8Array(65536), v = new DataView(data.buffer);
  v.setUint32(0, 0x20040000, true); v.setUint32(4, 0x200009, true); data.set(code, 8);
  return new Machine(engine, await loadImage(data));
}
test('debugging is opt-in and hook switching preserves execution and restores acceleration', async () => {
  const m = await machine();
  try {
    assert.ok(m.bridge); assert.deepEqual(m.report().debug, {enabled: false});
    assert.throws(() => m.debug.memory(0x200008, 2), /Enable/);
    m.run(2); assert.equal(m.reg('R0'), 1);
    for (let i = 0; i < 3; i++) {
      m.configureDebug({enabled: true}); assert.equal(m.bridge, null);
      m.run(2); assert.equal(m.reg('R0'), 2 + i * 2);
      assert.equal(m.report().debug.trace.length, 2);
      m.configureDebug({enabled: false}); assert.ok(m.bridge);
      m.run(2); assert.equal(m.reg('R0'), 3 + i * 2);
    }
    assert.equal(m.board.ticks, 14); assert.equal(m.error, null);
  } finally { m.close(); }
});
test('breakpoints stop before execution without advancing time, step/continue skips once then stops on a loop', async () => {
  const m = await machine();
  try {
    m.configureDebug({enabled: true, breakpoints: ['0x00200009']});
    let r = m.run(20);
    assert.equal(r.status, 'breakpoint'); assert.equal(r.pc, 0x200008); assert.equal(r.debug.registers.R0, 0); assert.equal(r.board.ticks, 0);
    assert.equal(r.debug.trace.length, 0);
    r = m.run(1); assert.equal(r.pc, 0x20000a); assert.equal(r.debug.registers.R0, 1); assert.equal(r.board.ticks, 1);
    r = m.run(20); assert.equal(r.status, 'breakpoint'); assert.equal(r.debug.registers.R0, 1); assert.equal(r.board.ticks, 2);
    r = m.run(20); assert.equal(r.status, 'breakpoint'); assert.equal(r.debug.registers.R0, 2); assert.equal(r.board.ticks, 4);
    m.configureDebug({breakpoints: [], traceLimit: 2}); r = m.run(6);
    assert.equal(r.status, 'paused'); assert.equal(r.debug.trace.length, 2); assert.equal(r.debug.trace[0].tick, 8);
    assert.deepEqual(r.debug.trace[0].bytes, [1, 0x30]);
    m.configureDebug({traceLimit: 0}); assert.equal(m.run(2).debug.trace.length, 0);
  } finally { m.close(); }
});
test('debug configuration is validated atomically and memory inspection is bounded and side effect free', async () => {
  const m = await machine();
  try {
    m.configureDebug({enabled: true, breakpoints: [0x200008]});
    for (const options of [{enabled: 1}, {traceLimit: 4097}, {traceLimit: -1}, {breakpoints: [NaN]}, {breakpoints: ['garbage']}, {breakpoints: [0x40000000]}, {breakpoints: [0xffffffff]}, {breakpoints: Array(65).fill(0x200008)}]) {
      assert.throws(() => m.configureDebug(options)); assert.deepEqual(m.debug.config(), {enabled: true, breakpoints: [0x200008], traceLimit: 256});
    }
    assert.deepEqual(m.debug.memory('0x200008', 4), {address: 0x200008, bytes: [1, 0x30, 0xfd, 0xe7]});
    assert.deepEqual(m.debug.memory(0x8000008, 4).bytes, [1, 0x30, 0xfd, 0xe7]);
    for (const [at, n] of [[0x40004404, 4], [0x2003ffff, 2], [0x210000, 1], [0x200000, 4097], [0x200000, 0], [-1, 4]]) assert.throws(() => m.debug.memory(at, n));
    assert.equal(m.board.ticks, 0); assert.equal(m.error, null);
  } finally { m.close(); }
});
test('fault reports retain the faulting instruction, registers and bounded history', async () => {
  const m = await machine([1, 0x48, 0, 0x68, 0xfe, 0xe7, 0, 0xbf, 0, 0, 3, 0x40]);
  try {
    m.configureDebug({enabled: true}); const r = m.run(10);
    assert.match(r.error, /Unmodeled peripheral/); assert.equal(r.debug.registers.R0, 0x40030000);
    assert.equal(r.debug.trace.at(-1).pc, 0x20000a); assert.equal(r.pc, 0x20000a);
    assert.deepEqual(m.debug.memory(r.pc, 2).bytes, [0, 0x68]);
  } finally { m.close(); }
});
test('a breakpoint suspends pending IRQ delivery and debugging preserves exception return', async () => {
  const m = await machine();
  try {
    m.mem.put(0x200000 + (16 + 55) * 4, 0x200401); m.mem.write(0x200400, new Uint8Array([0x70, 0x47]));
    m.configureDebug({enabled: true, breakpoints: [0x200008]}); m.irq.enabled = 1n << 55n; m.irq.pend(55);
    let r = m.run(20); assert.equal(r.interrupts.delivered, 0); assert.equal(r.sp, 0x20040000);
    m.configureDebug({breakpoints: [0x200400]}); r = m.run(20);
    assert.equal(r.pc, 0x200400); assert.equal(r.interrupts.delivered, 1); assert.deepEqual(r.interrupts.active, [55]);
    r = m.run(1); assert.equal(r.pc, 0x200008); assert.equal(r.sp, 0x20040000); assert.deepEqual(r.interrupts.active, []);
    m.configureDebug({enabled: false}); r = m.run(2); assert.equal(r.error, null); assert.equal(m.reg('R0'), 1);
  } finally { m.close(); }
});
