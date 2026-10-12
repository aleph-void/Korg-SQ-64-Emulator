const $ = id => document.getElementById(id);
import {BrowserEmulator} from './client.js';
import {displayPixels} from './display.js';
import {OUTPUT_GROUPS} from './outputs.js';
import {KnobMotion} from './knob.js';
import {debugView} from './debug-view.js';
import {frameRenderer} from './pacing.js';
const device = window.parent !== window && window.parent.sq64Emulator ? window.parent.sq64Emulator : new BrowserEmulator();
let lastState;
const debuggerUI = debugView({request: api, save});
const held = new Set();
const queueRender = frameRenderer(render);
const displayContext = $('display').getContext('2d'), displayImage = displayContext.createImageData(256, 64);
const displayedBytes = new Uint8Array(8192);
let displayDrawn = false, limitations;
function update(state) {
  // Debugger commands use this state before their promise resolves (including
  // the checkbox's pending state); only the instrument paint is deferred.
  debuggerUI.render(state); queueRender(state);
}
async function api(path, data = {}, raw = false) {
  if (device.locked && !['state', 'recording'].includes(path)) throw Error('Wait for the current updater or backup operation to finish');
  const result = await device.request(path, raw ? {bytes: data, transport: $('midi-route').value} : data);
  if (result && typeof result.loaded === 'boolean') update({...result, locked: device.locked}); return result;
}
const act = task => Promise.resolve().then(task).catch(error => { $('status').textContent = error.message; });
function button(control, label, parent, pad = false) {
  const b = document.createElement('button'); b.className = pad ? 'pad' : 'control'; b.textContent = label; b.dataset.control = control;
  b.setAttribute('aria-label', pad ? `Pad ${control}` : label); b.setAttribute('aria-pressed', 'false'); b.disabled = true;
  const send = down => { if (down) held.add(control); else held.delete(control); b.setAttribute('aria-pressed', String(down)); act(() => api('event', {type: 'button', control, down})); };
  b.addEventListener('pointerdown', e => { e.preventDefault(); b.setPointerCapture(e.pointerId); if (e.shiftKey) { b.dataset.latched = b.dataset.latched === 'true' ? 'false' : 'true'; send(b.dataset.latched === 'true'); } else send(true); });
  const release = () => { if (b.dataset.latched !== 'true' && held.has(control)) send(false); };
  b.addEventListener('pointerup', release); b.addEventListener('pointercancel', release); b.addEventListener('lostpointercapture', release);
  b.addEventListener('keydown', e => { if ([' ', 'Enter'].includes(e.key) && !e.repeat) { e.preventDefault(); send(true); } });
  b.addEventListener('keyup', e => { if ([' ', 'Enter'].includes(e.key)) { e.preventDefault(); send(false); } });
  $(parent).append(b);
}
function knob(name, parent) {
  const wrap = document.createElement('div'); wrap.className = 'knob';
  const b = document.createElement('button'); b.className = 'dial'; b.dataset.encoder = name; b.setAttribute('aria-label', name + ' encoder'); b.disabled = true;
  const label = document.createElement('label'); label.textContent = name; wrap.append(b, label); $(parent).append(wrap);
  const turn = delta => { if (delta && !b.disabled) act(() => api('event', {type: 'encoder', control: name, delta})); }; let previous;
  const motion = new KnobMotion();
  b.addEventListener('wheel', e => { if (b.disabled) return; e.preventDefault(); turn(motion.wheel(e)); }, {passive: false});
  b.addEventListener('keydown', e => { if (['ArrowLeft', 'ArrowRight'].includes(e.key)) { e.preventDefault(); turn(e.key === 'ArrowRight' ? 1 : -1); } });
  b.addEventListener('pointerdown', e => { if (b.disabled) return; motion.reset(); previous = e.clientY; b.setPointerCapture(e.pointerId); });
  b.addEventListener('pointermove', e => { if (previous !== undefined) { turn(motion.drag(previous - e.clientY, e.shiftKey)); previous = e.clientY; } });
  const release = () => { previous = undefined; motion.reset(); };
  b.addEventListener('pointerup', release); b.addEventListener('pointercancel', release); b.addEventListener('lostpointercapture', release); b.addEventListener('blur', release);
}
for (const group of OUTPUT_GROUPS) {
  const section = document.createElement('div'); section.className = 'output-group'; section.setAttribute('role', 'group'); section.setAttribute('aria-label', `Track ${group.label} outputs`);
  const label = document.createElement('span'); label.className = 'output-track'; label.textContent = group.label; section.append(label);
  for (const {id, label, name} of group.outputs) {
    const light = document.createElement('span'); light.className = 'output-indicator'; light.dataset.output = id; light.dataset.led = '0'; light.setAttribute('role', 'img'); light.setAttribute('aria-label', `${name}: off`); light.title = name;
    const lens = document.createElement('span'); lens.className = 'output-lens'; lens.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span'); text.textContent = label; text.setAttribute('aria-hidden', 'true'); light.append(lens, text); section.append(light);
  }
  $('outputs').append(section);
}
['tempo', 'swing'].forEach(n => knob(n, 'left-knobs')); ['param1', 'param2', 'param3', 'param4'].forEach(n => knob(n, 'param-knobs'));
['tap', 'record', 'stop', 'play', 'control'].forEach(n => button(n, n.toUpperCase(), 'transport'));
['project', 'global', 'pattern', 'gate', 'pitch', 'mod', 'loop'].forEach(n => button(n, n.toUpperCase(), 'modes'));
['bar1', 'bar2', 'bar3', 'bar4', 'shift'].forEach(n => button(n, n.toUpperCase(), 'bars'));
for (const track of 'ABCD') { button(`track${track}`, track, 'matrix'); for (let i = 1; i <= 16; i++) button(track + i, String(i), 'matrix', true); }
function render(state) {
  lastState = state; $('image').disabled = !!state.locked; $('load-probe').disabled = !!state.locked; $('midi-route').disabled = !!state.locked;
  for (const id of ['run', 'pause', 'step', 'poweroff', 'reset', 'version', 'update', 'release', 'send-midi']) $(id).disabled = !state.loaded || state.locked;
  document.querySelectorAll('[data-control], [data-encoder]').forEach(b => { b.disabled = !state.loaded || state.locked; });
  for (const {outputs} of OUTPUT_GROUPS) for (const {id, name} of outputs) {
    const light = document.querySelector(`[data-output="${id}"]`), level = state.loaded && !state.report.board.poweredOff ? state.panel.outputs?.[id] || 0 : 0;
    light.dataset.led = String(level); light.classList.toggle('lit', level > 0); light.style.setProperty('--led-intensity', String(level / 255));
    light.setAttribute('aria-label', `${name}: ${level ? 'active' : 'off'}`);
  }
  if (!state.loaded) return;
  const r = state.report; $('pc').textContent = `0x${r.pc.toString(16).padStart(8, '0')}`; $('ticks').textContent = r.board.ticks.toLocaleString(); $('irq').textContent = String(r.interrupts.delivered);
  $('status').textContent = r.error || (r.debug?.stoppedAt != null ? `Breakpoint at 0x${r.debug.stoppedAt.toString(16).padStart(8, '0')}`
    : r.board.poweredOff ? 'Powered off · firmware finished shutdown'
    : !state.running && r.board.ticks === 0 ? 'Firmware loaded · press Power on to start'
    : state.running && state.panel.displayFrames === 0 ? 'Running · starting firmware; waiting for the first display frame'
    : `${state.running ? 'Running' : 'Paused'} · ${state.mode} startup`);
  for (const id of ['run', 'pause', 'step', 'poweroff', 'release', 'send-midi']) $(id).disabled ||= r.board.poweredOff;
  document.querySelectorAll('[data-control], [data-encoder]').forEach(b => { b.disabled ||= r.board.poweredOff; });
  $('midi').textContent = typeof state.midi === 'string' ? state.midi : state.midi.name;
  const nextLimitations = r.board.approximations.join('\n');
  if (limitations !== nextLimitations) {
    limitations = nextLimitations;
    $('limitations').replaceChildren(...r.board.approximations.map(text => { const li = document.createElement('li'); li.textContent = text; return li; }));
  }
  document.querySelectorAll('[data-control]').forEach(b => { b.setAttribute('aria-pressed', String(Boolean(state.panel.buttons[b.dataset.control]))); const level = state.panel.leds[b.dataset.control] || 0; b.classList.toggle('lit', level > 0); b.dataset.led = String(level); b.style.setProperty('--led-intensity', String(level / 255)); b.setAttribute('aria-description', level > 0 ? 'Firmware indicator lit' : 'Firmware indicator off'); });
  document.querySelectorAll('[data-encoder]').forEach(b => { b.style.setProperty('--rotation', `${state.panel.encoders[b.dataset.encoder] * 12}deg`); });
  if (!displayDrawn || state.panel.display.some((byte, i) => byte !== displayedBytes[i])) {
    displayPixels(state.panel.display, displayImage.data); displayContext.putImageData(displayImage, 0, 0);
    displayedBytes.set(state.panel.display); displayDrawn = true;
  }
  $('display-status').textContent = state.panel.displayFrames ? `${state.panel.displayFrames} FRAME TRANSACTIONS` : state.running ? 'STARTING FIRMWARE…' : 'WAITING FOR FIRMWARE';
  $('midi-log').textContent = r.board.midiOut.slice(-32).map(p => `${p.tick}: ${p.byte.toString(16).padStart(2, '0')}`).join('\n') || 'No output';
}
$('image').addEventListener('change', () => act(async () => { const f = $('image').files[0]; if (f) { if (f.size > 4 * 1024 * 1024) throw Error('Image exceeds 4 MiB'); await api('load', await f.arrayBuffer(), true); } }));
for (const id of ['run', 'pause', 'poweroff']) $(id).addEventListener('click', () => act(() => api(id)));
$('step').addEventListener('click', () => act(() => api('step', {instructions: 1000})));
for (const [id, mode] of [['reset', 'normal'], ['version', 'version'], ['update', 'update']]) $(id).addEventListener('click', () => act(() => api('reset', {mode})));
$('release').addEventListener('click', () => act(async () => { for (const control of ['global', 'pattern']) await api('event', {type: 'button', control, down: false}); }));
window.addEventListener('blur', () => { for (const control of held) act(() => api('event', {type: 'button', control, down: false})); held.clear(); });
$('send-midi').addEventListener('click', () => act(() => { const text = $('midi-bytes').value.trim(); if (!/^[0-9a-f]{2}(\s+[0-9a-f]{2})*$/i.test(text)) throw Error('Enter hexadecimal bytes separated by spaces'); return api('event', {type: 'midi', data: text.split(/\s+/).map(x => parseInt(x, 16))}); }));
function save(data, name) { const a = document.createElement('a'), url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'})); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000); }
const panel = document.querySelector('.instrument');
if (!panel.requestFullscreen) $('fullscreen').hidden = true;
$('fullscreen').addEventListener('click', () => act(() => document.fullscreenElement ? document.exitFullscreen() : panel.requestFullscreen()));
document.addEventListener('fullscreenchange', () => { $('fullscreen').textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen'; });
$('report').addEventListener('click', () => { if (lastState?.loaded) save(lastState.report, 'sq64-execution.json'); });
$('recording').addEventListener('click', () => act(async () => save(await device.request('recording'), 'sq64-inputs.json')));
$('replay').addEventListener('change', () => act(async () => { const f = $('replay').files[0]; if (f) await api('replay', JSON.parse(await f.text())); }));
device.addEventListener('state', event => update(event.detail));
device.addEventListener('fault', event => { $('status').textContent = event.detail; });
if (device.state) update(device.state);

$('load-probe').addEventListener('click', () => act(async () => {
  if (device.locked) throw Error('Wait for the current operation');
  $('midi-route').value = 'din';
  const response = await fetch('../examples/browser-probe.bin');
  if (!response.ok) throw Error('Integration probe is unavailable');
  await api('load', await response.arrayBuffer(), true); await api('run');
}));

// Fit the embedded panel to its content without trapping mobile scrolling.
if (window.parent !== window) new ResizeObserver(() => {
  const frame = window.frameElement;
  if (frame) frame.style.height = document.documentElement.scrollHeight + 'px';
}).observe(document.body);
