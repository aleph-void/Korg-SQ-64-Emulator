import {BUTTONS, PADS, ENCODERS} from './panel.js';

// Human clicks must survive the firmware's switch scan and debounce even when
// emulation runs slower than wall time. Record the actual virtual edges so a
// replay remains deterministic. Raw Machine events are deliberately unchanged.
export class InteractiveInputs {
  constructor(machine) { this.machine = machine; this.edges = new Map(); this.cursor = 0; this.nextEncoderTick = 0; }
  get pending() {
    return this.machine.board.ticks < Math.max(this.cursor, this.nextEncoderTick) ||
      this.machine.eventIndex < this.machine.events.length;
  }
  event(event) {
    const m = this.machine, dwell = Math.ceil(216000000 * 0.04 / m.board.cyclesPerInstruction);
    if (event.type === 'encoder') {
      if (!ENCODERS.includes(event.control) || !Number.isInteger(event.delta) || Math.abs(event.delta) > 128) throw Error('Invalid panel event');
      // Real-time wheel bursts otherwise arrive within a few virtual ms and
      // trigger firmware acceleration. Space detents in virtual time, shared
      // across knobs, and retain their ordering relative to held buttons.
      for (let i = 0; i < Math.abs(event.delta); i++) {
        const tick = Math.max(m.board.ticks, this.cursor, this.nextEncoderTick);
        m.queueEvent({...event, delta: Math.sign(event.delta)}, tick);
        this.cursor = this.nextEncoderTick = tick + dwell;
      }
      return;
    }
    if (event.type !== 'button') return this.machine.event(event);
    if (![...BUTTONS, ...PADS].includes(event.control) || typeof event.down !== 'boolean') throw Error('Invalid panel event');
    const previous = this.edges.get(event.control);
    if (previous?.down === event.down) return;
    const tick = Math.max(m.board.ticks, this.cursor, previous ? previous.tick + dwell : 0);
    m.queueEvent(event, tick); this.edges.set(event.control, {tick, down: event.down});
    this.cursor = tick; this.nextEncoderTick = Math.max(this.nextEncoderTick, tick + dwell);
  }
}
