const $ = id => document.getElementById(id);
import {debugView} from './debug-view.js';
import {conformanceView} from './conformance-view.js';
let token, lastState, polling = false;
const debuggerUI = debugView({request: api, save});
const validationUI = conformanceView({request: api, save});
const held = new Set();
async function api(path, data = {}, raw = false) {
  if (lastState?.terminated && path !== 'state') throw Error(lastState.terminated.message);
  const response = await fetch(`/api/${path}`, {method: 'POST', headers: {'Content-Type': raw ? 'application/octet-stream' : 'application/json', 'X-Session-Token': token}, body: raw ? data : JSON.stringify(data)});
  const result = await response.json(); if (!response.ok) throw Error(result.error);
  if (['load', 'reset'].includes(path)) document.querySelectorAll('[data-control]').forEach(b => b.dispatchEvent(new Event('panel-reset')));
  if (typeof result.loaded === 'boolean') render(result); return result;
}
const act = task => Promise.resolve().then(task).catch(error => { $('status').textContent = error.message; });
function button(control, label, parent, pad = false) {
  const b = document.createElement('button'); b.className = pad ? 'pad' : 'control'; b.textContent = label; b.dataset.control = control;
  b.setAttribute('aria-label', pad ? `Pad ${control}` : label); b.setAttribute('aria-pressed', 'false'); b.disabled = true;
  let presses = [], tipTimer, lastKeyPress = -Infinity;
  const clearTip = () => { clearTimeout(tipTimer); b.querySelector('[role=tooltip]')?.remove(); b.removeAttribute('aria-describedby'); presses = []; };
  b.addEventListener('panel-reset', () => { clearTip(); lastKeyPress = -Infinity; b.dataset.latched = 'false'; held.delete(control); });
  const notePress = () => {
    if (control !== 'shift') return;
    const now = performance.now(); presses = presses.filter(time => now - time <= 2000); presses.push(now);
    if (presses.length <= 3) return;
    let tip = b.querySelector('[role=tooltip]');
    if (!tip) {
      tip = document.createElement('span'); tip.id = 'shift-latch-tip'; tip.className = 'shift-tip'; tip.setAttribute('role', 'tooltip');
      tip.textContent = 'Double-click SHIFT to toggle its latched state.'; b.append(tip); b.setAttribute('aria-describedby', tip.id);
    }
    clearTimeout(tipTimer); tipTimer = setTimeout(clearTip, 6000);
  };
  const send = down => { if (down) held.add(control); else held.delete(control); b.setAttribute('aria-pressed', String(down)); act(() => api('event', {type: 'button', control, down})); };
  const toggle = () => { lastKeyPress = -Infinity; b.dataset.latched = b.dataset.latched === 'true' ? 'false' : 'true'; send(b.dataset.latched === 'true'); };
  b.addEventListener('pointerdown', e => { e.preventDefault(); b.setPointerCapture(e.pointerId); notePress(); if (control === 'shift') return; if (e.shiftKey) toggle(); else if (b.dataset.latched !== 'true') send(true); });
  b.addEventListener('dblclick', e => { if (control === 'shift' && !b.disabled) { e.preventDefault(); toggle(); } });
  const release = () => { if (b.dataset.latched !== 'true' && held.has(control)) send(false); };
  b.addEventListener('pointerup', release); b.addEventListener('pointercancel', release); b.addEventListener('lostpointercapture', release);
  b.addEventListener('keydown', e => {
    if (e.key === 'Escape') clearTip();
    if (![' ', 'Enter'].includes(e.key) || e.repeat || b.disabled) return;
    e.preventDefault(); notePress();
    if (control === 'shift') { const now = performance.now(); if (now - lastKeyPress <= 500) toggle(); else lastKeyPress = now; }
    else if (b.dataset.latched !== 'true') send(true);
  });
  b.addEventListener('keyup', e => { if ([' ', 'Enter'].includes(e.key)) { e.preventDefault(); if (control !== 'shift') release(); } });
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
  if (lastState?.terminated && !state.terminated) return;
  debuggerUI.render(state);
  validationUI.render(state);
  lastState = state;
  $('safety-stop').hidden = !state.terminated;
  $('safety-message').textContent = state.terminated ? state.terminated.message + '\n' + state.terminated.tests.map(r => r.id + ': ' + (r.operation || r.detail || '') + (r.address == null ? '' : ' at 0x' + r.address.toString(16))).join('\n') + '\nFirmware SHA-256: ' + state.terminated.imageSha256 : '';
  for (const id of ['run', 'pause', 'step', 'reset', 'version', 'update', 'release', 'send-midi', 'replay']) $(id).disabled = !state.loaded || !!state.terminated;
  for (const id of ['image', 'recording', 'midi-bytes']) $(id).disabled = !!state.terminated;
  document.querySelectorAll('[data-control], [data-encoder]').forEach(b => { b.disabled = !state.loaded || !!state.terminated; });
  if (!state.loaded) return;
  const r = state.report; $('pc').textContent = `0x${r.pc.toString(16).padStart(8, '0')}`; $('ticks').textContent = r.board.ticks.toLocaleString(); $('irq').textContent = String(r.interrupts.delivered);
  $('status').textContent = state.terminated?.message || r.error || (r.debug?.stoppedAt != null ? `Breakpoint at 0x${r.debug.stoppedAt.toString(16).padStart(8, '0')}` : `${state.running ? 'Running' : 'Paused'} · ${state.mode} startup`);
  $('midi').textContent = typeof state.midi === 'string' ? state.midi : state.midi.name;
  $('limitations').replaceChildren(...r.board.approximations.map(text => { const li = document.createElement('li'); li.textContent = text; return li; }));
  document.querySelectorAll('[data-control]').forEach(b => { b.setAttribute('aria-pressed', String(Boolean(state.panel.buttons[b.dataset.control]))); b.classList.toggle('lit', state.panel.leds[b.dataset.control] > 0); });
  document.querySelectorAll('[data-encoder]').forEach(b => { b.style.setProperty('--rotation', `${state.panel.encoders[b.dataset.encoder] * 12}deg`); });
  const context = $('display').getContext('2d'), pixels = context.createImageData(256, 64);
  for (let i = 0; i < 16384; i++) {
    const pair = parseInt(state.panel.display.slice((i >> 1) * 2, (i >> 1) * 2 + 2), 16);
    const value = ((i & 1) ? pair & 15 : pair >> 4) * 17;
    pixels.data.set([value * .83, value * .9, value, 255], i * 4);
  }
  context.putImageData(pixels, 0, 0); $('display-status').textContent = `${state.panel.displayFrames} FRAME TRANSACTIONS`;
  $('midi-log').textContent = r.board.midiOut.slice(-32).map(p => `${p.tick}: ${p.byte.toString(16).padStart(2, '0')}`).join('\n') || 'No output';
}
$('image').addEventListener('change', () => act(async () => { const f = $('image').files[0]; if (f) { if (f.size > 4 * 1024 * 1024) throw Error('Image exceeds 4 MiB'); await api('load', await f.arrayBuffer(), true); } }));
for (const id of ['run', 'pause']) $(id).addEventListener('click', () => act(() => api(id)));
$('step').addEventListener('click', () => act(() => api('step', {instructions: 1000})));
for (const [id, mode] of [['reset', 'normal'], ['version', 'version'], ['update', 'update']]) $(id).addEventListener('click', () => act(() => api('reset', {mode})));
$('release').addEventListener('click', () => act(async () => { for (const control of ['global', 'pattern']) await api('event', {type: 'button', control, down: false}); }));
window.addEventListener('blur', () => {
  for (const control of held) if (document.querySelector(`[data-control="${control}"]`).dataset.latched !== 'true') {
    act(() => api('event', {type: 'button', control, down: false})); held.delete(control);
  }
});
$('send-midi').addEventListener('click', () => act(() => { const text = $('midi-bytes').value.trim(); if (!/^[0-9a-f]{2}(\s+[0-9a-f]{2})*$/i.test(text)) throw Error('Enter hexadecimal bytes separated by spaces'); return api('event', {type: 'midi', data: text.split(/\s+/).map(x => parseInt(x, 16))}); }));
function save(data, name) { const a = document.createElement('a'), url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'})); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000); }
$('report').addEventListener('click', () => { if (lastState?.loaded) save(lastState.report, 'sq64-execution.json'); });
$('recording').addEventListener('click', () => act(async () => save(await (await fetch('/api/replay')).json(), 'sq64-inputs.json')));
$('replay').addEventListener('change', () => act(async () => { const f = $('replay').files[0]; if (f) await api('replay', JSON.parse(await f.text())); }));
async function poll() { if (polling) return; polling = true; try { render(await (await fetch('/api/state')).json()); } catch { $('status').textContent = 'Local emulator connection lost'; } finally { polling = false; } }
try { token = (await (await fetch('/api/session')).json()).token; await poll(); setInterval(poll, 500); } catch (error) { $('status').textContent = error.message; }
