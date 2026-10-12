import test from 'node:test';
import assert from 'node:assert/strict';
import {Panel, INPUT_WIRES, BUTTONS, PADS, ENCODERS} from '../emulator/panel.js';
const parallel = serial => Array.from({length: 4}, (_, i) => ((serial[i + 1] & 1) << 7) | (serial[i + 2] >>> 1)).reduce((v, b, i) => v | b << (i * 8), 0) >>> 0;
const scan = row => Uint8Array.of(0, 0, 1 << row, 0, 0, 0, 255, 252);
test('all 85 buttons have distinct active-high matrix inputs and release cleanly', () => {
  const p = new Panel(), wires = new Set();
  for (const name of [...BUTTONS, ...PADS]) {
    const [row, bit] = INPUT_WIRES[name]; assert.ok(!wires.has(`${row}/${bit}`)); wires.add(`${row}/${bit}`);
    p.event({type: 'button', control: name, down: true}, 1);
    for (let r = 0; r < 8; r++) assert.equal(parallel(p.input(r)), r === row ? 1 << bit : 0);
    p.event({type: 'button', control: name, down: false}, 2); assert.equal(parallel(p.input(row)), 0);
  }
  assert.equal(wires.size, 85);
});
test('polled SPI samples the previous selected row at the latch, preserving startup chord signals', () => {
  const p = new Panel(); p.event({type:'button', control:'global', down:true},0);p.event({type:'button', control:'pattern', down:true},0);
  const received = [];
  for(let i=0;i<10;i++) { received.push(Uint8Array.of(1 << (i % 8),0,0,0,255,60).map(b=>p.exchange(b)));p.latch(false);p.latch(true); }
  assert.equal(received[8][2],8);assert.equal(received[9][2],8);
  p.event({type:'button',control:'global',down:false},0);assert.equal(p.input(6)[4],0);
});
test('drum triggers latch active-low polled outputs independently of the selected LED row', () => {
  const p = new Panel();
  for (const mask of [1, 128, 0]) {
    for (const byte of [1, 0, 0, 0, 255 ^ mask, 252]) p.exchange(byte);
    assert.notEqual(p.triggers, mask); p.latch(true); assert.equal(p.triggers, mask);
  }
});
test('six encoders produce ordered quadrature edges and preserve direction reversals', () => {
  for (let i=0;i<ENCODERS.length;i++) {
    const p=new Panel();p.event({type:'encoder',control:ENCODERS[i],delta:1},0);p.event({type:'encoder',control:ENCODERS[i],delta:-1},1);
    const phases=[];
    const bit = [4, 6, 12, 14, 8, 10][i];
    for(let row=1;row<=4;row++){p.scanFrame(scan(row));phases.push(parallel(p.input(row)) >>> bit & 3);}
    assert.deepEqual(phases,[1,3,1,0]);assert.equal(p.encoders[ENCODERS[i]],0);
  }
});
test('LED states come from row PWM and auxiliary output bits, independently of button state', () => {
  const p=new Panel(), on=scan(0),off=scan(0);on[5]=2;on[7]=236;
  for(let i=0;i<64;i++)p.scanFrame(i<32?on:off);p.scanFrame(scan(1));
  assert.equal(p.leds.A1,128);assert.equal(p.leds.stop,128);assert.equal(p.buttons.A1,false);
  for(let row=2;row<8;row++)p.scanFrame(scan(row));
  for(let i=0;i<64;i++)p.scanFrame(scan(0));p.scanFrame(scan(1));assert.equal(p.leds.A1,0);
});
