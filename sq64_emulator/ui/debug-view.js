// Kept identical in the browser and native workbench distributions.
const hex = value => `0x${value.toString(16).padStart(8, '0')}`;
const bytes = values => values.map(v => v.toString(16).padStart(2, '0')).join(' ');
export function debugView({request, save}) {
  const $ = id => document.getElementById(id);
  let state, busy = false, lastConfig;
  async function act(task) {
    busy = true; render(state); $('debug-message').textContent = '';
    try { await task(); }
    catch (error) { $('debug-message').textContent = error.message; }
    finally { busy = false; render(state); }
  }
  function render(next) {
    if (next?.report?.imageSha256 !== state?.report?.imageSha256 || next?.report?.board.ticks < state?.report?.board.ticks) $('debug-memory').textContent = 'Read memory while paused.';
    state = next;
    const debug = state?.report?.debug, enabled = !!debug?.enabled;
    if (!busy) $('debug-enabled').checked = enabled;
    $('debug-enabled').disabled = busy || !state?.loaded || !!state?.terminated || !!state?.locked;
    $('debug-tools').hidden = !enabled;
    for (const element of $('debug-tools').querySelectorAll('input, button')) element.disabled = busy || !enabled || !!state?.terminated || !!state?.locked;
    $('debug-save').disabled = busy || !state?.report || (!!state?.locked && !state?.terminated);
    if (!enabled) { $('debug-memory').textContent = 'Read memory while paused.'; lastConfig = undefined; return; }
    const paused = !state.running;
    $('debug-step').disabled ||= !!state.report.error || !!state.report.board.poweredOff;
    $('debug-read').disabled ||= !paused;
    $('debug-stop').textContent = state.terminated ? 'Terminated · critical conformance test passed' : state.report.error ? `Fault: ${state.report.error}` : debug.stoppedAt !== null ? `Breakpoint at ${hex(debug.stoppedAt)}` : state.running ? 'Running' : 'Paused';
    $('debug-points').textContent = debug.breakpoints.map(hex).join(', ') || 'No breakpoints';
    $('debug-registers').textContent = Object.entries(debug.registers).map(([name, value]) => `${name.padEnd(9)} ${hex(value)}`).join('\n');
    $('debug-trace').textContent = debug.trace.map(row => `${String(row.tick).padStart(8)}  ${hex(row.pc)}  ${bytes(row.bytes)}`).join('\n') || 'No trace entries';
    const config = JSON.stringify([debug.breakpoints, debug.traceLimit]);
    if (config !== lastConfig) {
      $('debug-breakpoints').value = debug.breakpoints.map(hex).join(' ');
      $('debug-trace-limit').value = debug.traceLimit; lastConfig = config;
    }
  }
  $('debug-enabled').addEventListener('change', event => { const enabled = event.target.checked; act(() => request('debug', {enabled})); });
  $('debug-step').addEventListener('click', () => act(() => request('step', {instructions: 1})));
  $('debug-apply').addEventListener('click', () => {
    const options = {breakpoints: $('debug-breakpoints').value.trim().split(/[\s,]+/).filter(Boolean), traceLimit: Number($('debug-trace-limit').value)};
    act(() => request('debug', options));
  });
  $('debug-read').addEventListener('click', () => act(async () => {
    const memory = await request('debug-memory', {address: $('debug-address').value.trim(), length: Number($('debug-length').value)});
    $('debug-memory').textContent = Array.from({length: Math.ceil(memory.bytes.length / 16)}, (_, i) => `${hex(memory.address + i * 16)}  ${bytes(memory.bytes.slice(i * 16, i * 16 + 16))}`).join('\n');
  }));
  $('debug-save').addEventListener('click', () => act(async () => {
    const snapshot = await request('state'); save(snapshot.report, 'sq64-debug.json');
  }));
  render();
  return {render};
}
