import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import createUnicorn from '../vendor/unicorn-arm.js';
import {Machine} from '../emulator/core.js';
import {loadImage} from '../emulator/image.js';
import {SpiFlash} from '../emulator/flash.js';
import {midiPackets, packetBytes} from '../emulator/midi.js';
import {createBackup} from '../src/backup.js';
import {updateFirmware} from '../src/session.js';
import {parseVsb} from '../src/protocol.js';
import {syntheticVsb} from './fixtures.js';

const engine = await createUnicorn();
function program(code) { const data = new Uint8Array(65536), v = new DataView(data.buffer); v.setUint32(0, 0x20040000, true); v.setUint32(4, 0x200009, true); data.set(code, 8); return data; }

test('WASM executes Thumb from the reset vector and rejects unaligned LDM', async () => {
  const data = program([1, 0x48, 2, 0xc8, 0xfe, 0xe7, 0, 0xbf, 1, 0, 0, 0x20]);
  const m = new Machine(engine, await loadImage(data));
  assert.match(m.run(10).error, /alignment/); m.close();
});
test('Cortex-M interrupt roundtrip restores the stack', async () => {
  const data = program([0xfe, 0xe7]), v = new DataView(data.buffer);
  v.setUint32((16 + 55) * 4, 0x200401, true); data.set([0x70, 0x47], 0x400);
  const m = new Machine(engine, await loadImage(data)); m.irq.enabled = 1n << 55n; m.irq.pend(55);
  const r = m.run(20); assert.equal(r.error, null); assert.equal(r.sp, 0x20040000); assert.equal(r.interrupts.delivered, 1); m.close();
});
test('native bridge preserves instruction budgets, high MMIO addresses, IRQ masks and IT slots', async () => {
  // Original Thumb probe: CPSID; enable/pend IRQ0; set its priority; CPSIE;
  // then alternate R4 through true/false ITE slots. IRQ0 returns with BX LR.
  const data = program([114,182,7,72,1,33,1,96,192,248,0,17,5,74,32,35,19,112,98,182,0,36,0,44,12,191,1,36,0,36,250,231,0,225,0,224,0,228,0,224]);
  new DataView(data.buffer).setUint32(16 * 4, 0x200401, true); data.set([0x70, 0x47], 0x400);
  const image = await loadImage(data), fast = new Machine(engine, image), scalar = new Machine(engine, image, {execution: 'scalar'});
  try {
    assert.ok(fast.bridge, 'test the shipped native bridge, not the scalar fallback');
    let ticks = 0;
    for (const count of [1, 2, 1, 3, 1, 2, 1, 2, 3, 17, 128, 1023, 1, 1, 1]) {
      fast.run(count); scalar.run(count); ticks += count;
      assert.equal(fast.error, null); assert.equal(scalar.error, null); assert.equal(fast.board.ticks, ticks);
      for (const reg of ['PC', 'R0', 'R1', 'R2', 'R3', 'R4', 'SP', 'LR', 'XPSR', 'PRIMASK']) assert.equal(fast.reg(reg), scalar.reg(reg), reg);
      assert.deepEqual(fast.irq.report(), scalar.irq.report());
      assert.deepEqual(fast.mem.read(0xe000e000, 0x2000), scalar.mem.read(0xe000e000, 0x2000));
    }
    assert.equal(fast.irq.delivered, 1); assert.equal(fast.mem.get(0xe000e400, 1), 32);
  } finally { fast.close(); scalar.close(); }
});
test('USB MIDI packing covers all SysEx tail sizes', () => {
  for (let n = 0; n < 24; n++) { const data = [240, ...Array.from({length: n}, (_, i) => i), 247]; assert.deepEqual(packetBytes(midiPackets(data)).flatMap(x => Array.from(x[1])), data); }
});
test('SPI protects writes and implements NOR bit clearing', () => {
  const flash = new SpiFlash(); const tx = bytes => { flash.select(true); try { return bytes.map(b => flash.exchange(b)); } finally { flash.select(false); } };
  assert.throws(() => tx([2, 0, 0, 0, 42]), /enable/); tx([6]); tx([2, 0, 0, 0, 42]); tx([6]); tx([2, 0, 0, 0, 255]); assert.equal(flash.data[0], 42);
});
test('updater and backup execute an independently authored ARM probe and verify staging contents', async () => {
  let reply;
  const m = new Machine(engine, await loadImage(readFileSync(new URL('../examples/browser-probe.bin', import.meta.url))), {transport: 'din', onMidi: data => { reply = data; }});
  const session = {closed: false, close() { this.closed = true; }, async exchange(data) {
    reply = null; m.board.injectMidi(data, 'din');
    for (let i = 0; !reply && i < 200; i++) { m.run(10000); if (m.error) throw Error(m.error); }
    if (!reply) throw Error('ARM firmware failed to reply'); return reply;
  }};
  const backup = await createBackup(session, {scope: 'current'}); assert.equal(backup.complete, true); assert.equal(backup.records.length, 9);
  const data = syntheticVsb(); const result = await updateFirmware(session, parseVsb(data), {delay: async () => {}});
  assert.equal(result.packets, 224); assert.equal(m.board.flash.writes, 229376);
  assert.deepEqual(m.board.flash.data.slice(0x40000, 0x78000), data.slice(256)); m.close();
});

test('NOR storage retains the last project slot without aliasing the first MiB', () => {
  const flash=new SpiFlash(),tx=data=>{flash.select(true);try{return data.map(b=>flash.exchange(b));}finally{flash.select(false);}};
  assert.equal(flash.data.length,16*1024*1024);assert.deepEqual(tx([159,0,0,0]).slice(1),[239,64,24]);
  tx([6]);tx([2,255,255,255,42]);assert.equal(tx([3,255,255,255,0])[4],42);assert.equal(flash.data[0xfffff],255);
  tx([6]);tx([32,255,240,0]);assert.equal(flash.data[0xffffff],255);
});


test('power button is active low and only firmware releasing power-hold stops the CPU', async () => {
  const m = new Machine(engine, await loadImage(program([0xfe, 0xe7])));
  try {
    m.board.write(0x40020418, 4, 0x800000); // Initialization with the latch already low.
    assert.equal(m.board.poweredOff, false);
    m.board.read(0x40020810, 4); assert.ok(m.mem.get(0x40020810) & 8192);
    m.board.write(0x40020418, 4, 128);
    m.event({type: 'power', down: true});
    m.board.read(0x40020810, 4); assert.equal(m.mem.get(0x40020810) & 8192, 0);
    m.run(20); assert.equal(m.board.ticks, 20); assert.equal(m.board.poweredOff, false);
    m.board.write(0x40020418, 4, 0x800000);
    m.run(20); assert.equal(m.board.ticks, 20); assert.equal(m.board.poweredOff, true);
  } finally { m.close(); }
});
