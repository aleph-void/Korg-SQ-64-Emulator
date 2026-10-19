import test from 'node:test';
import assert from 'node:assert/strict';
import {SpiFlash} from '../emulator/flash.js';
import {Panel} from '../emulator/panel.js';
import {Machine} from '../emulator/core.js';

// W25Q contract, without a firmware fixture or browser input normalization.
test('CS, BUSY, wrapped page latch, WEL, rejected busy writes and interruption', () => {
  const f = new SpiFlash();
  const tx = (data, end = true) => { f.select(true); const rx = data.map(b => f.exchange(b)); if (end) f.select(false); return rx; };
  tx([6]); tx([2,0,0,255,0x12,0x34], false);
  assert.equal(f.data[255],255); f.select(false);
  assert.equal(tx([5,0])[1],3); assert.equal(f.data[0],255);
  tx([6]); tx([2,0,1,0,0]); f.advance(1023); assert.equal(f.data[255],255);
  f.advance(1024); assert.deepEqual([f.data[0],f.data[255],f.data[256]], [0x34,0x12,255]);
  assert.equal(tx([5,0])[1],0);
  tx([2,0,1,0,0]); f.advance(2048); assert.equal(f.data[256],255);
  tx([6]);tx([2,0,2,0,...Array(256).fill(0),0xf0]);f.advance(3072);assert.equal(f.data[512],0xf0);
  tx([6]); tx([32,0,2,0]); f.advance(3073); f.powerCut(); f.advance(100000);
  assert.equal(f.data[512],0xf0);
});
test('raw panel bits and encoder lines bypass wiring guesses and scan pacing', () => {
  const p = new Panel();
  p.event({type:'panel-bit',row:3,bit:31,value:1},0);
  assert.equal(p.input(3)[5],0); assert.equal(p.input(3)[4]&1,1);
  p.event({type:'encoder-lines',control:'tempo',value:3},1);
  assert.equal(p.encoderPhase[0],2); assert.equal(p.encoderEdges[0].length,0);
  p.scanFrame(Uint8Array.of(0,0,2,0,0,0,0,0));
  assert.equal(p.encoderPhase[0],2);
  p.event({type:'encoder-lines',control:'tempo',value:2},2);
  assert.equal(p.encoderPhase[0],3);
});
test('capture replay preserves edges and reports instruction-boundary quantization', () => {
  const m = {board:{cycles:160,ticks:10,cyclesPerInstruction:16},replay:Machine.prototype.replay};
  const result = Machine.prototype.replayCycles.call(m,[{cycle:161,type:'encoder-lines',control:'tempo',value:1},{cycle:175,type:'encoder-lines',control:'tempo',value:3}]);
  assert.equal(result.maxQuantizationCycles,15);assert.deepEqual(m.events.map(e=>e.tick),[11,11]);
  assert.throws(()=>Machine.prototype.replayCycles.call(m,[{cycle:159}]),/future/);
});
