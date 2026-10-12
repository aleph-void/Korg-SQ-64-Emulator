import test from 'node:test';
import assert from 'node:assert/strict';
import {InteractiveInputs} from '../emulator/input.js';
import {Machine} from '../emulator/core.js';

function fixture() {
  const received = [], machine = {board: {ticks: 0, cyclesPerInstruction: 16}, events: [], eventIndex: 0,
    event(event) { received.push({...event, tick: this.board.ticks}); }, queueEvent: Machine.prototype.queueEvent};
  const advance = tick => { machine.board.ticks = tick; while (machine.eventIndex < machine.events.length && machine.events[machine.eventIndex].tick <= tick) machine.event(machine.events[machine.eventIndex++]); };
  return {machine, received, advance, input: new InteractiveInputs(machine)};
}
test('short clicks and double-clicks keep distinct press and release scan intervals', () => {
  const {input, machine, received, advance} = fixture();
  for (const down of [true, false, true, false]) input.event({type: 'button', control: 'play', down});
  assert.deepEqual(received.map(e => e.down), [true]);
  assert.deepEqual(machine.events.map(e => e.tick), [540000, 1080000, 1620000]);
  for (const tick of [540000, 1080000, 1620000]) advance(tick);
  assert.deepEqual(received.map(e => e.down), [true, false, true, false]);
});
test('holds, simultaneous controls and encoder events preserve user ordering', () => {
  const {input, machine, received} = fixture();
  input.event({type: 'button', control: 'global', down: false}); // Release a startup chord.
  input.event({type: 'button', control: 'A1', down: true});
  input.event({type: 'button', control: 'A1', down: true}); // Ignore duplicate pointer/key press.
  input.event({type: 'encoder', control: 'param1', delta: 1});
  machine.board.ticks = 2000000; input.event({type: 'button', control: 'A1', down: false});
  assert.equal(machine.events.length, 0); assert.equal(received.length, 4);
  assert.equal(received.at(-1).tick, 2000000);
  assert.throws(() => input.event({type: 'button', control: 'unknown', down: true}), /Invalid/);
});
