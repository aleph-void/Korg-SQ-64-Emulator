import createUnicorn from '../vendor/unicorn-arm.js';
import {loadImage} from './image.js';
import {Machine} from './core.js';
import {InteractiveInputs} from './input.js';
import {sha256} from '../src/protocol.js';
let engine, machine, inputs, running = false, mode = 'normal', options = {transport: 'usb'}, lastState = 0;
const onMidi = data => postMessage({type: 'midi', data});
const state = () => machine ? {loaded: true, running, mode, midi: 'In-browser MIDI · ' + options.transport.toUpperCase(), report: machine.report(), panel: machine.board.panel.snapshot()} : {loaded: false, running: false};
function notify() { postMessage({type: 'state', state: state()}); lastState = performance.now(); }
async function action(name, data) {
  if (name === 'load') {
    const image = await loadImage(data.bytes); engine ||= await createUnicorn();
    options = {transport: data.transport || 'usb', mapping: data.mapping || {}};
    const replacement = new Machine(engine, image, {...options, onMidi}); machine?.close(); machine = replacement;
    inputs = new InteractiveInputs(machine);
    running = false; mode = 'normal'; return state();
  }
  if (!machine) throw Error('Load firmware into the emulator first');
  if (name === 'run') running = true;
  else if (name === 'poweroff') { machine.event({type: 'power', down: true}); running = true; }
  else if (name === 'pause') running = false;
  else if (name === 'step') { running = false; machine.run(data.instructions || 1000); }
  else if (name === 'reset') {
    if (!['normal', 'version', 'update'].includes(data.mode)) throw Error('Unknown boot mode');
    running = false;
    const flash = machine.mem.read(0x200000, 65536), spi = machine.board.flash.data.slice();
    const storedBytes = new Uint8Array(flash.length + spi.length); storedBytes.set(flash); storedBytes.set(spi, flash.length);
    const image = {...machine.image, segments: [{address: 0x200000, data: flash}, ...machine.image.segments.filter(s => s.address !== 0x200000)], spi, stack: new DataView(flash.buffer).getUint32(0, true), reset: new DataView(flash.buffer).getUint32(4, true), sha256: await sha256(storedBytes)};
    machine.close(); machine = new Machine(engine, image, {...options, onMidi}); mode = data.mode;
    inputs = new InteractiveInputs(machine);
    if (mode !== 'normal') machine.event({type: 'button', control: 'global', down: true});
    if (mode === 'update') machine.event({type: 'button', control: 'pattern', down: true});
    running = true;
  } else if (name === 'event') inputs.event(data);
  else if (name === 'midi') { machine.event({type: 'midi', data: Array.from(data)}); running = true; }
  else if (name === 'replay') machine.replay(data);
  else if (name === 'recording') return machine.board.panel.events;
  else if (name === 'storage') return {flash: machine.mem.read(0x200000, 65536), spi: machine.board.flash.data.slice()};
  else if (name !== 'state') throw Error('Unknown emulator operation');
  return state();
}
let sequence = Promise.resolve();
self.onmessage = ({data: message}) => {
  sequence = sequence.then(async () => {
    try { const result = await action(message.action, message.data); postMessage({id: message.id, result}); notify(); }
    catch (error) { postMessage({id: message.id, error: String(error.message || error)}); }
  });
};
function pump() {
  try {
    if (running && machine) {
      // Keep work slices short enough for input/pause messages, while avoiding
      // a browser timer wake-up after every small batch of CPU instructions.
      const deadline = performance.now() + 12;
      do {
        machine.run(50000);
        if (machine.board.poweredOff) running = false;
        if (machine.error) { running = false; postMessage({type: 'fault', error: machine.error}); }
      } while (running && performance.now() < deadline);
    }
    if (machine && performance.now() - lastState >= 50) notify();
  } catch (error) { running = false; postMessage({type: 'fault', error: String(error.message || error)}); }
  if (running) wake.port2.postMessage(0);
  else setTimeout(pump, 25);
}
// Message tasks yield to input without nested setTimeout's 4 ms browser clamp.
const wake = new MessageChannel(); wake.port1.onmessage = pump;
pump();
