export const BUTTONS = ['tap', 'record', 'stop', 'play', 'control', 'project', 'global', 'pattern', 'gate', 'pitch', 'mod', 'loop', 'shift', 'bar1', 'bar2', 'bar3', 'bar4', 'trackA', 'trackB', 'trackC', 'trackD'];
export const PADS = [...'ABCD'].flatMap(t => Array.from({length: 16}, (_, i) => t + (i + 1)));
export const ENCODERS = ['tempo', 'swing', 'param1', 'param2', 'param3', 'param4'];
// Electrical input matrix: row select, bit in the 32 parallel input lines.
export const INPUT_WIRES = {
  tap: [0, 0], record: [1, 0], stop: [0, 1], play: [1, 1], control: [0, 18],
  trackA: [0, 17], trackB: [0, 16], trackC: [1, 18], trackD: [1, 17],
  gate: [2, 18], pitch: [2, 17], mod: [3, 18], loop: [3, 17],
  bar1: [4, 18], bar2: [4, 17], bar3: [5, 18], bar4: [5, 17],
  global: [6, 18], project: [6, 17], pattern: [7, 18], shift: [7, 17]
};
for (const [track, columns] of Object.entries({A: [26, 24], B: [25, 23], C: [22, 20], D: [21, 19]}))
  for (let i = 0; i < 16; i++) INPUT_WIRES[track + (i + 1)] = [i % 8, columns[i >> 3]];
const LED_WIRES = {control: [0, 17], gate: [0, 18], pitch: [0, 19], mod: [0, 20], loop: [2, 17], bar1: [2, 18], bar2: [2, 19], bar3: [4, 17], bar4: [4, 18], global: [4, 19], project: [6, 17], pattern: [6, 18], shift: [6, 19]};
for (let t = 0; t < 4; t++) {
  LED_WIRES['track' + 'ABCD'[t]] = [t * 2, 0];
  for (let i = 1; i <= 16; i++) LED_WIRES['ABCD'[t] + i] = [t * 2, i];
}
const GRAY = [0, 1, 3, 2];
export class Panel {
  constructor(mapping = {}) {
    this.buttons = Object.fromEntries([...BUTTONS, ...PADS].map(n => [n, false]));
    this.encoders = Object.fromEntries(ENCODERS.map(n => [n, 0])); this.leds = Object.fromEntries([...BUTTONS, ...PADS].map(n => [n, 0]));
    for (const [name, wire] of Object.entries(mapping)) if (!(name in this.buttons) || !Array.isArray(wire) || wire.length !== 2 || !wire.every(Number.isInteger) || wire[0] < 0 || wire[0] >= 48 || wire[1] < 0 || wire[1] >= 8) throw Error('Invalid panel wiring');
    this.mapping = mapping; this.rx = new Uint8Array(48).fill(255); this.display = new Uint8Array(8192); this.displayFrames = 0; this.events = []; this.row = 0;
    this.encoderPhase = Array(6).fill(0); this.encoderEdges = Array.from({length: 6}, () => []);
    this.shiftTx = []; this.shiftRx = new Uint8Array(6); this.selectedRow = 0;
    this.ledRows = Array.from({length: 8}, () => Array(32).fill(0)); this.ledCounts = Array(32).fill(0); this.ledSamples = 0; this.ledRow = 0;
  }
  event(event, tick) {
    const {type, control, down, delta} = event;
    if (type === 'button' && control in this.buttons && typeof down === 'boolean') {
      this.buttons[control] = down;
      const wire = this.mapping[control]; if (wire) { if (down) this.rx[wire[0]] &= ~(1 << wire[1]); else this.rx[wire[0]] |= 1 << wire[1]; }
    } else if (type === 'encoder' && control in this.encoders && Number.isInteger(delta) && Math.abs(delta) <= 128) {
      const index = ENCODERS.indexOf(control), queue = this.encoderEdges[index];
      if (queue.length + Math.abs(delta) * 2 > 4096) throw Error('Encoder input queue full');
      for (let i = 0; i < Math.abs(delta) * 2; i++) queue.push(Math.sign(delta));
      this.encoders[control] += delta;
    } else throw Error('Invalid panel event');
    if (this.events.length >= 100000) throw Error('Input recording capacity exceeded');
    this.events.push({...event, tick});
  }
  input(row) {
    let bits = 0;
    for (const [name, [r, bit]] of Object.entries(INPUT_WIRES)) if (r === row && this.buttons[name]) bits |= 1 << bit;
    for (let i = 0; i < 6; i++) bits |= GRAY[this.encoderPhase[i]] << (4 + i * 2);
    const b = Array.from({length: 4}, (_, i) => bits >>> (i * 8) & 255);
    // Fifteen serial clocks precede the 32 input bits in an eight-byte scan.
    return Uint8Array.of(0, b[0] >>> 7, b[0] << 1 | b[1] >>> 7, b[1] << 1 | b[2] >>> 7, b[2] << 1 | b[3] >>> 7, b[3] << 1, 0, 0);
  }
  exchange(value) {
    const index = this.shiftTx.length; this.shiftTx.push(value);
    if (index >= 6) throw Error('Panel shift register requires a latch after six bytes');
    return this.shiftRx[index];
  }
  latch(high) {
    if (!high) this.shiftRx = this.input(this.selectedRow).slice(2);
    else {
      const mask = this.shiftTx[0]; if (mask && !(mask & (mask - 1))) this.selectedRow = Math.log2(mask);
      this.shiftTx = [];
    }
  }
  frame(data) { if (data.length !== 8192) throw Error('Unsupported display frame'); this.display.set(data); this.displayFrames++; }
  scanFrame(tx) {
    if (tx.length !== 8) throw Error('Panel DMA frame must have eight bytes');
    const result = Object.keys(this.mapping).length ? Uint8Array.of(255, 255, ...this.rx.slice(this.row * 6, this.row * 6 + 6)) : this.input(this.row), mask = tx[2];
    if (mask && !(mask & (mask - 1))) {
      const row = Math.log2(mask);
      if (row !== this.row) for (let i = 0; i < 6; i++) {
        const edge = this.encoderEdges[i].shift(); if (edge) this.encoderPhase[i] = (this.encoderPhase[i] + edge + 4) % 4;
      }
      this.row = row; this.decodeLeds(tx, row);
    }
    return result;
  }
  decodeLeds(tx, row) {
    if (row !== this.ledRow && this.ledSamples) {
      this.ledRows[this.ledRow] = this.ledCounts.map(n => Math.round(n * 255 / this.ledSamples));
      this.ledCounts.fill(0); this.ledSamples = 0; this.ledRow = row;
      for (const [name, [r, bit]] of Object.entries(LED_WIRES)) this.leds[name] = Math.max(this.ledRows[r][bit], this.ledRows[r + 1][bit]);
      this.leds.tap = Math.max(this.ledRows[0][28], this.ledRows[0][29]);
      this.leds.stop = this.ledRows[0][30]; this.leds.record = this.ledRows[1][29]; this.leds.play = this.ledRows[1][30];
    }
    const bits = tx[5] | tx[4] << 8 | (tx[3] & 31) << 16 | ((~tx[7] & 60) >>> 2) << 28;
    for (let bit = 0; bit < 32; bit++) if (bits & 1 << bit) this.ledCounts[bit]++;
    this.ledSamples++;
  }
  snapshot() { return {buttons: {...this.buttons}, encoders: {...this.encoders}, leds: {...this.leds}, display: this.display, displayFrames: this.displayFrames, wiringVerified: false, mappedControls: Object.keys(this.mapping).length ? Object.keys(this.mapping) : Object.keys(INPUT_WIRES)}; }
}
