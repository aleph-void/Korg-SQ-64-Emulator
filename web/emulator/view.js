const $ = id => document.getElementById(id);
import {BrowserEmulator} from './client.js';
import {displayPixels} from './display.js';
const device = window.parent !== window && window.parent.sq64Emulator ? window.parent.sq64Emulator : new BrowserEmulator();
let lastState;
const held = new Set();
async function api(path, data = {}, raw = false) {
  if (device.locked && !['state', 'recording'].includes(path)) throw Error('Wait for the current updater or backup operation to finish');
  const result = await device.request(path, raw ? {bytes: data, transport: $('midi-route').value} : data);
  if (result && typeof result.loaded === 'boolean') render(result); return result;
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
  const turn = delta => act(() => api('event', {type: 'encoder', control: name, delta})); let previous;
  b.addEventListener('wheel', e => { e.preventDefault(); turn(e.deltaY < 0 ? 1 : -1); }, {passive: false});
  b.addEventListener('keydown', e => { if (['ArrowLeft', 'ArrowRight'].includes(e.key)) { e.preventDefault(); turn(e.key === 'ArrowRight' ? 1 : -1); } });
  b.addEventListener('pointerdown', e => { previous = e.clientY; b.setPointerCapture(e.pointerId); });
  b.addEventListener('pointermove', e => { if (previous !== undefined && Math.abs(e.clientY - previous) > 5) { turn(e.clientY < previous ? 1 : -1); previous = e.clientY; } });
  b.addEventListener('pointerup', () => { previous = undefined; }); b.addEventListener('pointercancel', () => { previous = undefined; });
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
  if (!state.loaded) return;
  const r = state.report; $('pc').textContent = `0x${r.pc.toString(16).padStart(8, '0')}`; $('ticks').textContent = r.board.ticks.toLocaleString(); $('irq').textContent = String(r.interrupts.delivered);
  $('status').textContent = r.error || (r.board.poweredOff ? 'Powered off · firmware finished shutdown'
    : !state.running && r.board.ticks === 0 ? 'Firmware loaded · press Power on to start'
    : state.running && state.panel.displayFrames === 0 ? 'Running · starting firmware; waiting for the first display frame'
    : `${state.running ? 'Running' : 'Paused'} · ${state.mode} startup`);
  for (const id of ['run', 'pause', 'step', 'poweroff', 'release', 'send-midi']) $(id).disabled ||= r.board.poweredOff;
  document.querySelectorAll('[data-control], [data-encoder]').forEach(b => { b.disabled ||= r.board.poweredOff; });
  $('midi').textContent = typeof state.midi === 'string' ? state.midi : state.midi.name;
  $('limitations').replaceChildren(...r.board.approximations.map(text => { const li = document.createElement('li'); li.textContent = text; return li; }));
  document.querySelectorAll('[data-control]').forEach(b => { b.setAttribute('aria-pressed', String(Boolean(state.panel.buttons[b.dataset.control]))); b.classList.toggle('lit', state.panel.leds[b.dataset.control] > 0); });
  document.querySelectorAll('[data-encoder]').forEach(b => { b.style.setProperty('--rotation', `${state.panel.encoders[b.dataset.encoder] * 12}deg`); });
  const context = $('display').getContext('2d'), pixels = context.createImageData(256, 64);
  pixels.data.set(displayPixels(state.panel.display));
  context.putImageData(pixels, 0, 0); $('display-status').textContent = state.panel.displayFrames ? `${state.panel.displayFrames} FRAME TRANSACTIONS` : state.running ? 'STARTING FIRMWARE…' : 'WAITING FOR FIRMWARE';
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
device.addEventListener('state', event => render(event.detail));
device.addEventListener('fault', event => { $('status').textContent = event.detail; });
if (device.state) render(device.state);

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
