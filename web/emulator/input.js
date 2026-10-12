import {BUTTONS, PADS} from './panel.js';

// Human clicks must survive the firmware's switch scan and debounce even when
// emulation runs slower than wall time. Record the actual virtual edges so a
// replay remains deterministic. Raw Machine events are deliberately unchanged.
export class InteractiveInputs {
  constructor(machine) { this.machine = machine; this.edges = new Map(); }
  event(event) {
    if (event.type !== 'button') return this.machine.event(event);
    if (![...BUTTONS, ...PADS].includes(event.control) || typeof event.down !== 'boolean') throw Error('Invalid panel event');
    const m = this.machine, previous = this.edges.get(event.control);
    if (previous?.down === event.down) return;
    const dwell = Math.ceil(216000000 * 0.04 / m.board.cyclesPerInstruction);
    const tick = Math.max(m.board.ticks, previous ? previous.tick + dwell : 0);
    m.queueEvent(event, tick); this.edges.set(event.control, {tick, down: event.down});
  }
}
