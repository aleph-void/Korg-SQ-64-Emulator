import test from 'node:test';
import assert from 'node:assert/strict';
import createUnicorn from '../vendor/unicorn-arm.js';
import {Machine} from '../emulator/core.js';
import {loadImage} from '../emulator/image.js';
import {CriticalMonitor} from '../emulator/critical.js';
import {SpiFlash} from '../emulator/flash.js';
const engine = await createUnicorn();
function program(address, value = 1) {
  const data = new Uint8Array(65536), view = new DataView(data.buffer);
  view.setUint32(0, 0x20040000, true); view.setUint32(4, 0x200009, true);
  data.set([1, 0x48, 2, 0x49, 1, 0x60, 0xfe, 0xe7], 8);
  view.setUint32(16, address, true); view.setUint32(20, value, true); return data;
}
for (const execution of ['scalar', undefined]) test(`ARM critical writes terminate ${execution || 'fast'} execution and retain first result`, async () => {
  for (const [address, value, id] of [[0x200020,1,'CRITICAL-001'],[0x8000020,1,'CRITICAL-001'],[0x40023c10,0x10002,'CRITICAL-001'],[0x40023c10,4,'CRITICAL-001'],[0x40023c08,1,'CRITICAL-002'],[0x40023c14,1,'CRITICAL-002'],[0x1ff0f000,1,'CRITICAL-002']]) {
    const m = new Machine(engine, await loadImage(program(address, value)), {execution});
    try {
      const report = m.run(20), hit = report.critical.results.find(r => r.status === 'pass');
      assert.equal(report.status, 'terminated', JSON.stringify(report));
      assert.equal(hit.id, id); assert.equal(hit.severity, 'critical'); assert.equal(hit.unsafeWhen, 'pass'); assert.equal(hit.address, address);
      assert.equal(hit.imageSha256, m.image.sha256); assert.match(report.error, /probably will brick.*Do not flash/);
      const ticks = m.board.ticks; m.run(20); assert.equal(m.board.ticks, ticks);
      assert.equal(m.mem.get(0x200020), 0); assert.equal(m.mem.get(0x8000020), 0);
    } finally { m.close(); }
  }
});
test('critical SPI pass precedes erase, program and unknown commands; staging remains writable', () => {
  for (const bytes of [[2,0,0,0,42],[32,0,0,0],[216,2,255,255],[199],[96],[1],[0x42],[0xff]]) {
    const critical = new CriticalMonitor('a'.repeat(64)), flash = new SpiFlash(undefined, critical); flash.data[0] = 3; flash.enabled = true; flash.select(true);
    assert.throws(() => bytes.forEach(b => flash.exchange(b)), /Do not flash/); assert.equal(flash.writes, 0); assert.equal(flash.data[0], 3);
    assert.equal(critical.report().terminated, true);
  }
  const critical = new CriticalMonitor('b'.repeat(64)), flash = new SpiFlash(undefined, critical);
  flash.enabled = true; flash.select(true); [2,4,0,0,42].forEach(b => flash.exchange(b)); assert.equal(flash.data[0x40000],42); assert.equal(critical.report().terminated,false);
});
test('DMA checks include incremented spans, alternate buffers and configuration writes', () => {
  for (const [control, target] of [[1,0x8000000],[1|1024,0x1fffffff],[1|0x40000,0x20000100]]) {
    const values = new Map([[0x40026010,control],[0x40026014,8],[0x4002601c,target],[0x40026020,0x40023c14]]);
    const monitor = new CriticalMonitor('c'.repeat(64)); assert.throws(() => monitor.dma(a => values.get(a)||0), /Do not flash/);
    assert.equal(monitor.hit.source,'dma');
  }
  const monitor = new CriticalMonitor('d'.repeat(64)), values = new Map([[0x4002601c,0x8000000]]);
  assert.throws(() => monitor.dmaWrite(0x40026010,4,1,a => values.get(a)||0), /Do not flash/);
});
function stores(writes) {
  const data = new Uint8Array(65536), view = new DataView(data.buffer), pool = (8 + writes.length * 6 + 2 + 3) & ~3;
  view.setUint32(0,0x20040000,true); view.setUint32(4,0x200009,true);
  writes.forEach(([address,value,size=4],index) => {
    const pc=8+index*6, literal=pool+index*8;
    view.setUint16(pc,0x4800|((literal-((pc+4)&~3))/4),true);
    view.setUint16(pc+2,0x4900|((literal+4-((pc+6)&~3))/4),true);
    view.setUint16(pc+4,size===1?0x7001:0x6001,true);
    view.setUint32(literal,address,true);view.setUint32(literal+4,value,true);
  }); view.setUint16(8+writes.length*6,0xe7fe,true);return data;
}
for (const execution of ['scalar',undefined]) test(`ARM SPI and DMA hazards stop before storage mutation (${execution || 'fast'})`,async()=>{
  const cases=[
    {writes:[[0x40020418,0x02000000],[0x4000380c,199,1]],id:'CRITICAL-003'},
    {writes:[[0x40020418,0x02000000],...[2,0,0,0,42].map(v=>[0x4000380c,v,1])],id:'CRITICAL-004'},
    {writes:[[0x40020418,0x02000000],...[32,0,0,0].map(v=>[0x4000380c,v,1])],id:'CRITICAL-004'},
    {writes:[[0x40026014,8],[0x40026018,0x4000380c],[0x4002601c,0x8000020],[0x40026010,1]],id:'CRITICAL-001',source:'dma'},
  ];
  for(const c of cases){const m=new Machine(engine,await loadImage(stores(c.writes)),{execution});try{
    const r=m.run(100);assert.equal(r.status,'terminated',r.error);const hit=r.critical.results.find(r=>r.status==='pass');assert.equal(hit.id,c.id);if(c.source)assert.equal(hit.source,c.source);
    assert.equal(m.board.flash.writes,0);assert.equal(m.mem.get(0x8000020),new DataView(m.image.segments[0].data.buffer).getUint32(0x20,true));
  }finally{m.close();}}
});
