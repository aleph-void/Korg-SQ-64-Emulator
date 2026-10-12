import test from 'node:test';
import assert from 'node:assert/strict';
import {ExecutionSlice, frameRenderer} from '../emulator/pacing.js';

function harness() {
  let time = 0, cost = .001;
  const calls = [];
  const machine = {debug: {enabled: false, stoppedAt: null}, board: {poweredOff: false}, error: null,
    run(count) { calls.push(count); time += count * cost; }};
  return {machine, calls, slice: new ExecutionSlice(() => time), now: () => time, slowDown() { cost = .01; }};
}

test('worker adapts instruction batches when execution becomes expensive and yields at display deadlines', () => {
  const h = harness();
  assert.equal(h.slice.run(h.machine), true); assert.equal(h.now(), 4);
  h.slowDown();
  h.slice.run(h.machine); // Observe the new cost without another large batch.
  const start = h.now(), before = h.calls.length;
  h.slice.run(h.machine);
  assert.ok(h.now() - start <= 4.01);
  assert.ok(h.calls.slice(before).every(count => count <= 200));
  const deadline = h.now() + 1;
  h.slice.run(h.machine, deadline); assert.ok(h.now() <= deadline + .01);
  const count = h.calls.length;
  h.slice.run(h.machine, h.now()); assert.equal(h.calls.length, count);
});

test('worker stops immediately on a breakpoint, power release or fault', () => {
  for (const stop of [m => { m.debug.stoppedAt = 0x200008; }, m => { m.board.poweredOff = true; }, m => { m.error = 'fault'; }]) {
    const h = harness(), run = h.machine.run;
    h.machine.run = count => { run(count); stop(h.machine); };
    assert.equal(h.slice.run(h.machine), false); assert.equal(h.calls.length, 1);
  }
  const h = harness(); h.machine.debug.enabled = true;
  h.slice.run(h.machine); assert.ok(h.calls.every(count => count <= 1000));
});

test('rendering coalesces bursts and paints the latest state after a suspended frame', () => {
  const frames = [], painted = [], render = frameRenderer(state => painted.push(state), cb => frames.push(cb));
  for (let i = 0; i < 100; i++) render({ticks: i});
  assert.equal(frames.length, 1); assert.deepEqual(painted, []);
  frames.shift()(); assert.deepEqual(painted, [{ticks: 99}]);
  render({ticks: 100, running: false}); frames.shift()();
  assert.deepEqual(painted.at(-1), {ticks: 100, running: false});
});
