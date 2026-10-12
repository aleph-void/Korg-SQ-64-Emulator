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

test('an unplugged sync jack reads high and does not stop the internal tempo', () => {
  const b = board(); b.put(0x40020410, 0x81); b.read(0x40020410, 4);
  assert.equal(b.get(0x40020410), 0x91);
  b.syncConnected = true; b.read(0x40020410, 4); assert.equal(b.get(0x40020410), 0x81);
});

test('APB timer clocks honor independent bus divisors and TIMPRE', () => {
  const b = board();
  b.put(0x40023808, 5 << 10 | 6 << 13); // APB1 / 4; APB2 / 8.
  assert.equal(b.timerClockDivider(0x40000000), 2);
  assert.equal(b.timerClockDivider(0x40011400), 4);
  b.put(0x4002388c, 1 << 24);
  assert.equal(b.timerClockDivider(0x40000000), 1);
  assert.equal(b.timerClockDivider(0x40011400), 2);
  b.put(0x40023808, 4 << 10 | 4 << 13);
  assert.equal(b.timerClockDivider(0x40000000), 1);
  assert.equal(b.timerClockDivider(0x40011400), 1);
  const pending = []; b.irq = {pend: n => pending.push([b.ticks, n])};
  b.put(0x40023808, 5 << 10); b.put(0x4002388c, 0);
  for (const [offset, value] of [[0x28, 15], [0x2c, 9], [12, 1], [0, 1]]) {
    b.write(0x40000000 + offset, 4, value); b.put(0x40000000 + offset, value);
  }
  for (let i = 0; i < 19; i++) b.advance(); assert.deepEqual(pending, []);
  b.advance(); assert.deepEqual(pending, [[20, 28]]);
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

test('deferred timers preserve overflow instructions across counter, divisor and enable changes', () => {
  const b = board(), pending = [], expected = [], timers = [0x40000000, 0x40000400, 0x40001400], irqs = [28,29,55];
  b.irq = {pend: irq => pending.push([b.ticks,irq])};
  const ref = timers.map(() => ({enabled:false, fraction:0, count:0, divisor:1, reload:65536, status:0, interrupt:0}));
  const write = (i, offset, value) => {
    const address = timers[i] + offset; b.write(address,4,value); b.put(address,value);
    const t=ref[i]; if(offset===0)t.enabled=!!(value&1); if(offset===0x24)t.count=value; if(offset===0x28)t.divisor=value+1;
    if(offset===0x2c)t.reload=value===0?65536:value+1; if(offset===0x10)t.status=value; if(offset===12)t.interrupt=value;
  };
  timers.forEach((_,i)=>{write(i,0x28,i+1);write(i,0x2c,11+i*7);write(i,12,1);write(i,0,1);});
  let seed=0x641203;
  for(let tick=1;tick<=3000;tick++) {
    for(let i=0;i<ref.length;i++){const t=ref[i];if(!t.enabled)continue;t.fraction+=16;const increment=Math.floor(t.fraction/t.divisor);t.fraction%=t.divisor;
      if(increment){t.count+=increment;if(t.count>=t.reload){if(t.interrupt&1&&!(t.status&1))expected.push([tick,irqs[i]]);t.status|=1;}t.count%=t.reload;}}
    b.advance(); assert.deepEqual(pending,expected,`IRQ schedule at instruction ${tick}`);
    if(tick%13===0){for(let i=0;i<timers.length;i++){b.read(timers[i]+0x24,4);assert.equal(b.get(timers[i]+0x24),ref[i].count);}}
    if(tick%17===0){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;const i=(seed>>>0)%3;write(i,0x10,0);
      switch((seed>>>8)%4){case 0:write(i,0x28,(seed>>>16)%11);break;case 1:write(i,0x2c,(seed>>>16)%37);break;case 2:write(i,0x24,(seed>>>16)%43);break;case 3:write(i,0,ref[i].enabled?0:1);}}
  }
});
