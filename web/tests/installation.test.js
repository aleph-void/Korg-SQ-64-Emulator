import test from 'node:test';
import assert from 'node:assert/strict';
import createUnicorn from '../vendor/unicorn-arm.js';
import { Machine } from '../emulator/core.js';
import { loadImage } from '../emulator/image.js';
import { FirmwareInstallation } from '../emulator/installation.js';
import { CriticalMonitor } from '../emulator/critical.js';
import { SpiFlash } from '../emulator/flash.js';
import { parseVsb, frame } from '../src/protocol.js';
import { syntheticVsb } from './fixtures.js';

const caps = { protocol: 1, packetSize: 1024, flags: 2 };
const pkg = () => parseVsb(syntheticVsb());
function submitted(installation) {
  installation.receive(installation.plan.begin);
  for (let i = 0; i < installation.plan.count; i++) installation.receive(installation.plan.packet(i));
  return installation;
}
function monitor(complete = true) {
  const critical = new CriticalMonitor('boot-image');
  critical.installation = new FirmwareInstallation(pkg(), caps, 'selected-image');
  if (complete) submitted(critical.installation);
  return critical;
}

test('installation permission requires an exact complete ordered transfer of the selected image', () => {
  for (const scenario of ['prepared', 'partial', 'wrong-packet', 'wrong-begin', 'cancelled']) {
    const critical = monitor(false), install = critical.installation;
    if (scenario === 'wrong-begin') install.receive(frame(4, [0]));
    if (!['prepared', 'wrong-begin'].includes(scenario)) install.receive(install.plan.begin);
    if (scenario === 'partial') install.receive(install.plan.packet(0));
    if (scenario === 'wrong-packet') { const packet = install.plan.packet(0); packet[11] ^= 1; install.receive(packet); }
    if (scenario === 'cancelled') install.cancel();
    assert.throws(() => critical.spi('erase', 0, 65536), /Do not flash/, scenario);
  }
  const critical = monitor();
  assert.doesNotThrow(() => critical.spi('erase', 0, 65536));
  assert.equal(critical.report().terminated, false);
  assert.deepEqual(critical.report().installation, { policy: 'selected-update-image', phase: 'installing',
    imageSha256: 'selected-image', packetsSubmitted: 224, totalPackets: 224, mutationAttempted: true });
});

test('authorized SPI install permits expected bytes but rejects a differing byte before mutation', () => {
  for (const valid of [true, false]) {
    const critical = monitor(), flash = new SpiFlash(undefined, critical);
    const tx = data => { flash.select(true); try { return data.map(byte => flash.exchange(byte)); } finally { flash.select(false); } };
    flash.data.fill(0, 0, 0x30001);
    tx([6]); tx([216, 0, 0, 0]);
    assert.equal(flash.data[0xffff], 255); assert.equal(flash.data[0x10000], 0);
    tx([6]);
    if (valid) { tx([2, 0, 0, 0, 0]); assert.equal(flash.data[0], 0); }
    else { assert.throws(() => tx([2, 0, 0, 0, 1]), /Do not flash/); assert.equal(flash.data[0], 255); }
    assert.equal(flash.data[0x30000], 0);
  }
});

test('installation retains option, mass-erase, alias, DMA, geometry and unknown-command protection', () => {
  for (const operation of [
    c => c.memory(0x40023c14, 4, 1), c => c.memory(0x40023c10, 4, 4),
    c => c.memory(0x40023c10, 4, 0x10022), c => c.memory(0x200000, 4, 0x20040000),
    c => c.memory(0x08010000, 4, 0), c => c.memory(0x08000000, 4, 0),
    c => c.memory(0x08000000, 4, 0x20040000, 'dma'),
    c => c.spi('erase', 0x2f000, 65536), c => c.spi('erase', 0, 0x30000), c => c.command(199),
  ]) assert.throws(() => operation(monitor()), /Do not flash/);
});

test('candidate bytes are copied from offset views and permission expires on new MIDI traffic', () => {
  const candidate = parseVsb(Buffer.from(syntheticVsb()));
  const install = submitted(new FirmwareInstallation(candidate, caps, 'selected-image'));
  candidate.payload.fill(0);
  assert.equal(install.internal(0x8000000, 4, 0x20040000, 'cpu'), true);
  install.cancel(); // Host cancellation cannot undo an installation already submitted.
  assert.equal(install.phase, 'installing');
  install.receive(frame(0));
  assert.equal(install.internal(0x8000000, 4, 0x20040000, 'cpu'), false);
});

const engine = await createUnicorn();
function stores(writes) {
  const data = new Uint8Array(65536), view = new DataView(data.buffer), pool = (8 + writes.length * 6 + 2 + 3) & ~3;
  view.setUint32(0, 0x20040000, true); view.setUint32(4, 0x200009, true);
  writes.forEach(([address, value], i) => {
    const pc = 8 + i * 6, literal = pool + i * 8;
    view.setUint16(pc, 0x4800 | (literal - ((pc + 4) & ~3)) / 4, true);
    view.setUint16(pc + 2, 0x4900 | (literal + 4 - ((pc + 6) & ~3)) / 4, true);
    view.setUint16(pc + 4, 0x6001, true);
    view.setUint32(literal, address, true); view.setUint32(literal + 4, value, true);
  });
  view.setUint16(8 + writes.length * 6, 0xe7fe, true);
  return data;
}
for (const execution of ['scalar', undefined]) test(`ARM installer writes the selected internal bytes and rejects other bytes (${execution || 'fast'})`, async () => {
  for (const valid of [true, false]) {
    const code = stores([[0x40023c04, 0x45670123], [0x40023c04, 0xcdef89ab], [0x40023c10, 0x10002],
      [0x40023c10, 1], [0x8000000, valid ? 0x20040000 : 0x12345678]]);
    const m = new Machine(engine, await loadImage(code), { execution });
    try {
      // Original test program executes from RAM while its flash sector is erased.
      m.mem.write(0x20020000, code.subarray(8)); m.setReg('PC', 0x20020001);
      m.prepareUpdate(pkg(), caps, 'selected-image'); submitted(m.critical.installation); m.updateFlashPermissions();
      const report = m.run(100);
      assert.equal(report.critical.terminated, !valid);
      if (valid) assert.equal(report.error, null);
      else assert.equal(report.critical.results.find(r => r.status === 'pass').id, 'CRITICAL-001');
      for (const base of [0x200000, 0x8000000]) assert.equal(m.mem.get(base), valid ? 0x20040000 : 0xffffffff);
    } finally { m.close(); }
  }
});
