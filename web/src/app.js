import {parseVsb, sha256} from './protocol.js';
import {MidiSession, inspectUpdater, updateFirmware} from './session.js';
import {createBackup, validateBackup, restoreBackup} from './backup.js';
import {DemoSession} from './demo.js';
import {BrowserEmulator} from '../emulator/client.js';

const $ = id => document.getElementById(id);
let access, session, firmware, archive, busy = false, awaitingCompletion = false, fileRevision = 0, backupRevision = 0;
const emulator = new BrowserEmulator(); window.sq64Emulator = emulator;
let emulatorSelected = false;
$('emulator-frame').src = 'emulator/index.html';
const log = text => { $('log').textContent += `${text}\n`; $('log').scrollTop = $('log').scrollHeight; };
const status = text => { $('status').textContent = text; };
function refresh() {
  const connected = session && !session.closed;
  $('backup-start').disabled = busy || awaitingCompletion || !connected;
  $('update-start').disabled = busy || awaitingCompletion || !connected || !firmware || !$('ready').checked;
  $('restore-start').disabled = busy || awaitingCompletion || !connected || !archive || !$('restore-ready').checked;
  for (const id of ['connect', 'demo', 'emulated', 'open', 'input', 'output', 'channel', 'scope', 'firmware', 'backup-file', 'older', 'ready', 'restore-ready']) $(id).disabled = busy || awaitingCompletion;
  emulator.setLocked(busy || awaitingCompletion);
}
function save(value, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], {type: 'application/json'}));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
async function operation(task) {
  if (busy || awaitingCompletion) return;
  busy = true; refresh(); $('log').textContent = ''; $('progress').value = 0; $('percent').textContent = '';
  let wake;
  try {
    try { wake = await navigator.wakeLock?.request('screen'); } catch { /* Optional convenience. */ }
    await task();
  } catch (error) { status('Operation stopped'); log(error.message); }
  finally { await wake?.release(); busy = false; refresh(); }
}
window.addEventListener('beforeunload', event => { if (busy || awaitingCompletion) { event.preventDefault(); event.returnValue = ''; } });
for (let i = 0; i < 16; i++) $('channel').add(new Option(String(i + 1), String(i)));
document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
  document.querySelectorAll('.tab').forEach(tab => { tab.hidden = tab.id !== button.dataset.tab; });
}));
for (const id of ['ready', 'older', 'restore-ready']) $(id).addEventListener('change', refresh);
function portOptions() {
  if (busy) return;
  for (const [id, ports] of [['input', access.inputs], ['output', access.outputs]]) {
    const selected = $(id).value; $(id).replaceChildren();
    for (const port of ports.values()) if (port.state === 'connected') $(id).add(new Option(`${port.name || 'MIDI port'} · ${port.manufacturer || 'unknown'}`, port.id));
    if ([...$(id).options].some(o => o.value === selected)) $(id).value = selected;
  }
}
$('connect').addEventListener('click', async () => {
  try {
    if (!window.isSecureContext || !navigator.requestMIDIAccess) throw Error('Web MIDI is unavailable. Use a supported desktop browser over HTTPS or localhost.');
    access = await navigator.requestMIDIAccess({sysex: true});
    if (!access.sysexEnabled) throw Error('SysEx permission is required');
    access.addEventListener('statechange', () => { portOptions(); refresh(); if (session?.closed) $('connection-state').textContent = 'Device disconnected'; });
    portOptions(); $('ports').hidden = false; status('Choose the SQ-64 sequencer input and output');
  } catch (error) { status(error.message); }
});
$('open').addEventListener('click', async () => {
  try {
    const input = access.inputs.get($('input').value), output = access.outputs.get($('output').value);
    if (!input || !output) throw Error('Select both MIDI ports');
    await input.open(); await output.open(); session?.close(); emulatorSelected = false; session = new MidiSession(input, output);
    $('connection-state').textContent = 'MIDI ports connected'; $('mode-note').hidden = true; status('Connected. Use normal mode for backup, update mode for firmware.'); refresh();
  } catch (error) { status(error.message); }
});
$('demo').addEventListener('click', () => {
  session?.close(); emulatorSelected = false; session = new DemoSession(); $('mode-note').textContent = 'Synthetic protocol demonstration. No physical device is connected.'; $('connection-state').textContent = 'Protocol demonstration'; $('mode-note').hidden = false; status('Simulation ready'); refresh();
});
$('emulated').addEventListener('click', () => {
  $('browser-workbench').open = true;
  if (!emulator.loaded) { status('Load your firmware in the browser workbench below, then connect to it here.'); $('browser-workbench').scrollIntoView({behavior: 'smooth'}); return; }
  session?.close(); emulatorSelected = true; session = new MidiSession(emulator.input, emulator.output, {timeout: 30000});
  $('connection-state').textContent = 'Browser emulator connected'; $('mode-note').hidden = false;
  $('mode-note').textContent = 'ARM firmware runs in this browser. The updater is connected only to this emulator.';
  status('Emulator connected. Run firmware in normal mode for backups or update mode for installation.'); refresh();
});
emulator.addEventListener('fault', event => { if (emulatorSelected) { session?.close(); status('Emulator stopped: ' + event.detail); refresh(); } });
$('firmware').addEventListener('change', async () => {
  const revision = ++fileRevision; firmware = null; refresh();
  try {
    const file = $('firmware').files[0]; if (!file) return;
    if (file.size !== 0x38100) throw Error('Expected a 229,632-byte VSB system file');
    const parsed = parseVsb(await file.arrayBuffer()), digest = await sha256(parsed.data);
    if (revision !== fileRevision) return;
    firmware = parsed;
    $('file-info').textContent = `${file.name} · version ${parsed.version[0]}.${String(parsed.version[1]).padStart(2, '0')} · four checksums valid\nSHA-256 ${digest}`;
  } catch (error) { if (revision === fileRevision) $('file-info').textContent = error.message; }
  refresh();
});
$('backup-start').addEventListener('click', () => operation(async () => {
  status('Reading device contents…');
  const result = await createBackup(session, {scope: $('scope').value, channel: Number($('channel').value), onProgress: p => { status(`Reading ${p.kind}${p.index === null ? '' : ` ${p.index + 1}`} · ${p.captured} items`); }});
  save(result, `sq64-${session instanceof DemoSession ? 'demo-' : ''}backup-${new Date().toISOString().slice(0, 10)}.json`);
  $('progress').value = 100; status('Backup saved'); log(`${result.records.length} records validated. Firmware and factory calibration are excluded.`);
}));
$('update-start').addEventListener('click', () => operation(async () => {
  let began = false;
  try {
    await updateFirmware(session, firmware, {allowOlder: $('older').checked, onProgress: p => {
      if (p.phase === 'begin') began = true;
      status(p.phase === 'writing' ? 'Device is writing…' : p.phase === 'begin' ? 'Starting update…' : p.phase === 'await-device-completion' ? 'Waiting for completion on the device' : 'Transmitting firmware…');
      if (p.total) { const percent = Math.round(100 * p.done / p.total); $('progress').value = percent; $('percent').textContent = `${percent}%`; }
    }});
    awaitingCompletion = true; $('completion').hidden = false;
    log('All packets acknowledged. Confirm completion on the SQ-64 display before restarting.');
  } catch (error) { if (began) log('Update may have begun. Keep power connected and check the device. Do not blindly retry.'); throw error; }
}));
$('confirm-completion').addEventListener('click', () => { awaitingCompletion = false; $('completion').hidden = true; session?.close(); status('Device completion confirmed by you. Restart and reconnect to verify the new version.'); refresh(); });
$('backup-file').addEventListener('change', async () => {
  const revision = ++backupRevision; archive = null; refresh();
  try {
    const file = $('backup-file').files[0]; if (!file) return;
    if (file.size > 40 * 1024 * 1024) throw Error('Backup exceeds the 40 MiB limit');
    const parsed = await validateBackup(JSON.parse(await file.text()));
    if (revision !== backupRevision) return;
    archive = parsed; $('backup-info').textContent = `${file.name} · ${parsed.scope} · ${parsed.records.length} verified records`;
  } catch (error) { if (revision === backupRevision) $('backup-info').textContent = error.message; }
  refresh();
});
$('restore-start').addEventListener('click', () => operation(async () => {
  status('Restoring included data…');
  const result = await restoreBackup(session, archive, {channel: Number($('channel').value), onProgress: p => status(`Restored ${p.restored} records · ${p.kind}`)});
  $('progress').value = 100; status('Restore acknowledged by device'); log(`${result.restored} records written. Verify your projects, then use the power button and wait for shutdown before restarting. An abrupt reset can lose the restored catalog and current workspace. Persistence has not been checked for this restore.`);
}));
refresh();
