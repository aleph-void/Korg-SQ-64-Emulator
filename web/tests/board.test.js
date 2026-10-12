import test from 'node:test';
import assert from 'node:assert/strict';
import {Board} from '../emulator/board.js';
import {Interrupts} from '../emulator/interrupts.js';

function board() {
  const bytes = new Map();
  const memory = {
    get(a, n = 4) { let value = 0; for (let i = 0; i < n; i++) value |= (bytes.get(a + i) || 0) << (8 * i); return value >>> 0; },
    put(a, v, n = 4) { for (let i = 0; i < n; i++) bytes.set(a + i, v >>> (8 * i) & 255); },
    read(a, n) { return Uint8Array.from({length: n}, (_, i) => this.get(a + i, 1)); },
    write(a, data) { data.forEach((b, i) => this.put(a + i, b, 1)); },
  };
  return new Board(memory, {});
}

test('attached virtual USB host drives VBUS without changing other GPIO inputs', () => {
  const b = board(); b.put(0x40020010, 0x81);
  b.read(0x40020010, 4); assert.equal(b.get(0x40020010), 0x281);
});

test('panel DMA waits for the programmed SPI serial clock before half/full interrupts', () => {
  const b = board(), irqs = [];
  b.irq = {pend: n => irqs.push(n)};
  b.put(0x40023808, 4 << 13); // APB2 = core / 2
  b.put(0x40013000, 3 << 3); // SPI1 = APB2 / 16
  for (const [base, control, buffer] of [[0x40026458, 1 | 256 | 1024 | 64 | 24, 0x20001000], [0x40026440, 1 | 256 | 1024, 0x20002000]]) {
    b.put(base, control); b.put(base + 4, 128); b.put(base + 8, 0x4001300c); b.put(base + 12, buffer);
  }
  b.cycles = 16383; b.completeDma(); assert.equal(b.get(0x4002645c), 128); assert.deepEqual(irqs, []);
  b.cycles++; b.completeDma(); assert.equal(b.get(0x4002645c), 64); assert.deepEqual(irqs, [59]);
  assert.ok(b.get(0x40026400) & (1 << 26));
  b.completeDma(); assert.deepEqual(irqs, [59]);
  b.cycles += 16384; b.completeDma(); assert.equal(b.get(0x4002645c), 128); assert.deepEqual(irqs, [59, 59]);
  assert.ok(b.get(0x40026400) & (1 << 27));
  b.put(0x40013000, 4 << 3); assert.equal(b.panelTransferCycles(), 32768);
  b.put(0x40023808, 0); assert.equal(b.panelTransferCycles(), 16384);
});

test('disabled pending IRQs remain latched without repeated priority scans', () => {
  const irq = new Interrupts({mem: {get: () => 0xbf00}});
  irq.pend(67); let scans = 0; irq.eligible = () => { scans++; return null; };
  for (let i = 0; i < 100; i++) irq.instruction(0x200000);
  assert.equal(scans, 0); assert.equal(irq.pending, 1n << 67n);
  irq.enabled |= 1n << 67n; irq.instruction(0x200000); assert.equal(scans, 1);
});
