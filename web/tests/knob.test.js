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
  assert.equal(k.drag(9), 0); assert.equal(k.drag(-12), 0); assert.equal(k.drag(-9), -1);
  k.drag(9); k.reset(); assert.equal(k.drag(3), 0);
  assert.equal(k.wheel({deltaY: -40, deltaMode: 0}), 1);
  assert.equal(k.wheel({deltaY: -160, deltaMode: 0, shiftKey: true}), 1);
});

test('opposite turns unwind fractional movement without drifting at direction reversals', () => {
  const path = [15, -12, 9, -12]; // Returns to the start, with partial detents at each reversal.
  for (const fine of [false, true]) for (const direction of [-1, 1]) for (const packets of [1, 3, 12]) {
    const drag = new KnobMotion(), wheel = new KnobMotion(); let d = 0, w = 0;
    for (let repeat = 0; repeat < 20; repeat++) for (const distance of path) {
      for (let i = 0; i < packets; i++) {
        d += drag.drag(direction * distance * (fine ? 4 : 1) / packets, fine);
        w += wheel.wheel({deltaY: -direction * distance * 40 / 12 * (fine ? 4 : 1) / packets, deltaMode: 0, shiftKey: fine});
      }
    }
    assert.equal(d, 0); assert.equal(w, 0);
    assert.equal(drag.remainder, 0); assert.equal(wheel.remainder, 0);
  }
});

test('large wheel packets retain their undispatched distance when direction reverses', () => {
  const k = new KnobMotion();
  assert.equal(k.wheel({deltaY: -6000}), 128);
  assert.equal(k.wheel({deltaY: 6000}), -128);
  assert.equal(k.remainder, 0);
});
