import createUnicorn from '../vendor/unicorn-arm.js';
import {loadImage} from './image.js';
import {Machine} from './core.js';
import {InteractiveInputs} from './input.js';
import {ExecutionSlice, FRAME_INTERVAL} from './pacing.js';
import {parseVsb, sha256} from '../src/protocol.js';
import {validateImage} from './conformance/validate.js';
import {criticalStop} from './conformance/safety.js';
let engine, machine, inputs, running = false, mode = 'normal', options = {transport: 'usb'}, lastState = 0, statePending = false;
let loadedBytes, conformance = null, terminated = false;
let execution = new ExecutionSlice();
const onMidi = data => postMessage({type: 'midi', data});
const state = () => machine ? {loaded: true, running, mode, transport: options.transport, inputPending: inputs?.pending || false, midi: 'In-browser MIDI · ' + options.transport.toUpperCase(), report: {...machine.report(), conformance}, panel: {...machine.board.panel.snapshot(), outputs: machine.board.outputLevels()}} : {loaded: false, running: false};
function notify() {
  if (statePending) return;
  postMessage({type: 'state', state: state()}); lastState = performance.now(); statePending = true;
}
function terminateCritical() {
  if (terminated) return true;
  const stop = machine && criticalStop(machine.critical.report());
  if (!stop) return false;
  running = false; terminated = true;
  const snapshot = state(); snapshot.terminated = stop; snapshot.report.status = 'terminated';
  try { machine.close(); }
  finally { machine = null; postMessage({type: 'terminated', state: snapshot}); self.close(); }
  return true;
}
async function action(name, data) {
  if (name === 'load') {
    const bytes = new Uint8Array(data.bytes).slice();
    const image = await loadImage(bytes); engine ||= await createUnicorn();
    options = {transport: data.transport || 'usb', mapping: data.mapping || {}, cyclesPerInstruction: data.transport === 'din' ? 16 : 3};
    const replacement = new Machine(engine, image, {...options, onMidi}); machine?.close(); machine = replacement;
    loadedBytes = bytes; conformance = null;
    inputs = new InteractiveInputs(machine);
    execution = new ExecutionSlice();
    running = false; mode = 'normal'; return state();
  }
  if (!machine) throw Error('Load firmware into the emulator first');
  if (name === 'prepare-update') {
    if (mode !== 'update' || machine.board.poweredOff || machine.debug.enabled) throw Error('Start Update mode with debugging disabled before installing firmware');
    const pkg = parseVsb(new Uint8Array(data.bytes));
    machine.prepareUpdate(pkg, data.caps, await sha256(pkg.data));
  }
  else if (name === 'cancel-update') machine.cancelUpdate();
  else if (name === 'run') running = true;
  else if (name === 'poweroff') { machine.event({type: 'power', down: true}); running = true; }
  else if (name === 'pause') running = false;
  else if (name === 'validate') {
    conformance = await validateImage(loadedBytes);
    const stop = criticalStop(conformance);
    if (stop) {
      // Stop before yielding to the execution pump or any queued action.
      running = false; terminated = true;
      const snapshot = state();
      snapshot.terminated = stop; snapshot.report.status = 'terminated';
      try { machine.close(); }
      finally {
        machine = null;
        postMessage({type: 'terminated', state: snapshot});
        self.close();
      }
      return snapshot;
    }
  }
  else if (name === 'step') { running = false; machine.run(data.instructions || 1000); }
  else if (name === 'debug') { machine.configureDebug(data); execution = new ExecutionSlice(); running = false; }
  else if (name === 'debug-memory') {
    if (running) throw Error('Pause before inspecting memory');
    return machine.debug.memory(data.address, data.length);
  }
  else if (name === 'reset') {
    if (!['normal', 'version', 'update'].includes(data.mode)) throw Error('Unknown boot mode');
    running = false;
    const flash = machine.mem.read(0x200000, 65536), spi = machine.board.flash.data.slice();
    const storedBytes = new Uint8Array(flash.length + spi.length); storedBytes.set(flash); storedBytes.set(spi, flash.length);
    const image = {...machine.image, loadedImageSha256: machine.image.loadedImageSha256 || machine.image.sha256, segments: [{address: 0x200000, data: flash}, ...machine.image.segments.filter(s => s.address !== 0x200000)], spi, stack: new DataView(flash.buffer).getUint32(0, true), reset: new DataView(flash.buffer).getUint32(4, true), sha256: await sha256(storedBytes)};
    const debug = machine.debug.config();
    machine.close(); machine = new Machine(engine, image, {...options, cyclesPerInstruction: data.mode === 'normal' ? options.cyclesPerInstruction : 16, onMidi, debug}); mode = data.mode;
    inputs = new InteractiveInputs(machine);
    execution = new ExecutionSlice();
    if (mode !== 'normal') machine.event({type: 'button', control: 'global', down: true});
    if (mode === 'update') machine.event({type: 'button', control: 'pattern', down: true});
    running = !debug.enabled;
  } else if (name === 'event') inputs.event(data);
  else if (name === 'midi') { machine.event({type: 'midi', data: Array.from(data)}); if (!machine.debug.enabled) running = true; }
  else if (name === 'replay') machine.replay(data);
  else if (name === 'recording') return machine.board.panel.events;
  else if (name === 'storage') return {flash: machine.mem.read(0x200000, 65536), spi: machine.board.flash.data.slice()};
  else if (name !== 'state') throw Error('Unknown emulator operation');
  return state();
}
let sequence = Promise.resolve();
self.onmessage = ({data: message}) => {
  if (terminated) return;
  if (message.type === 'state-ack') { statePending = false; return; }
  sequence = sequence.then(async () => {
    if (terminated) return;
    try { const result = await action(message.action, message.data); if (!terminateCritical()) { postMessage({id: message.id, result}); notify(); } }
    catch (error) { if (terminateCritical()) return; postMessage({id: message.id, error: String(error.message || error)}); }
  });
};
function pump() {
  if (terminated) return;
  try {
    if (running && machine) {
      // Startup redraws must finish between timer ticks or the firmware loses
      // animation steps. Once USB is ready, restore the interactive clock so
      // button debounce and encoder spacing retain their normal wall time.
      if (machine.board.cyclesPerInstruction === 3 && machine.board.usb.phase === 'configured') machine.board.instructionTiming(16);
      const start = performance.now();
      if (start - lastState >= FRAME_INTERVAL) notify();
      // Yield at the next display deadline, and adapt sub-batches to measured
      // cost instead of allowing 50,000 instructions to overrun every slice.
      const deadline = statePending ? start + 4 : Math.min(start + 4, lastState + FRAME_INTERVAL);
      running = execution.run(machine, deadline);
      if (terminateCritical()) return;
      if (machine.error) postMessage({type: 'fault', error: machine.error});
    }
    if (machine && performance.now() - lastState >= FRAME_INTERVAL) notify();
  } catch (error) { if (terminateCritical()) return; running = false; postMessage({type: 'fault', error: String(error.message || error)}); }
  if (running) wake.port2.postMessage(0);
  else setTimeout(pump, 25);
}
// Message tasks yield to input without nested setTimeout's 4 ms browser clamp.
const wake = new MessageChannel(); wake.port1.onmessage = pump;
pump();
