import test from 'node:test';
import assert from 'node:assert/strict';
import {KnobMotion} from '../emulator/knob.js';

test('wheel and drag depend on distance, not browser event frequency', () => {
  for (const packets of [1, 4, 40]) {
    const wheel = new KnobMotion(), drag = new KnobMotion(); let w = 0, d = 0;
    for (let i = 0; i < packets; i++) { w += wheel.wheel({deltaY: -120 / packets, deltaMode: 0}); d += drag.drag(48 / packets); }
    assert.equal(w, 3); assert.equal(d, 4);
  }
  const k = new KnobMotion();
  assert.equal(k.wheel({deltaY: 0, deltaMode: 0}), 0);
  assert.equal(k.wheel({deltaY: -3, deltaMode: 1}), 1);
  k.reset(); assert.equal(k.wheel({deltaY: 1, deltaMode: 2}), -3);
});
test('fine movement, direction changes and gesture resets preserve small adjustments', () => {
  const k = new KnobMotion();
  assert.equal(k.drag(36, true), 0); assert.equal(k.drag(12, true), 1);
  assert.equal(k.drag(-12, false), -1);
  assert.equal(k.drag(9), 0); assert.equal(k.drag(-12), -1);
  k.drag(9); k.reset(); assert.equal(k.drag(3), 0);
  assert.equal(k.wheel({deltaY: -40, deltaMode: 0}), 1);
  assert.equal(k.wheel({deltaY: -160, deltaMode: 0, shiftKey: true}), 1);
});
