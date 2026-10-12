import { BUTTONS, PADS, ENCODERS } from './panel.js';

export const SCRIPT_FORMAT = 'sq64-ui-script';
export const MAX_SCRIPT_BYTES = 1024 * 1024;
export const SCRIPT_CONTROLS = [...BUTTONS, ...PADS];
const fields = {
  'power-on': ['mode'], 'power-off': [], wait: ['ms'],
  button: ['control', 'down'], press: ['control', 'ms'],
  encoder: ['control', 'delta'], midi: ['data'],
};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

// Scripts are data, never executable JavaScript. Validate the whole document
// before applying any actions or replacing a saved draft.
export function validateScript(value) {
  if (!object(value) || value.format !== SCRIPT_FORMAT || value.version !== 1)
    throw Error('Expected an SQ-64 UI script (format: sq64-ui-script, version: 1)');
  if (Object.keys(value).some(key => !['format', 'version', 'name', 'actions'].includes(key)))
    throw Error('Unknown script field');
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 120)
    throw Error('Script name must contain 1–120 characters');
  if (!Array.isArray(value.actions) || value.actions.length > 10000)
    throw Error('A script must contain an actions array with at most 10,000 actions');
  const actions = value.actions.map((action, index) => {
    const invalid = reason => { throw Error(`Action ${index + 1}: ${reason}`); };
    if (!object(action) || !Object.hasOwn(fields, action.type)) invalid('unknown action type');
    const required = fields[action.type];
    if (Object.keys(action).some(key => key !== 'type' && !required.includes(key)) ||
        required.some(key => !Object.hasOwn(action, key))) invalid('unexpected or missing fields');
    if (action.type === 'power-on' && !['normal', 'version', 'update'].includes(action.mode)) invalid('unknown startup mode');
    if (['button', 'press'].includes(action.type) && !SCRIPT_CONTROLS.includes(action.control)) invalid('unknown button or pad');
    if (action.type === 'button' && typeof action.down !== 'boolean') invalid('down must be true or false');
    if (['wait', 'press'].includes(action.type) && !integer(action.ms, 0, 3600000)) invalid('ms must be an integer from 0 to 3,600,000');
    if (action.type === 'encoder' && (!ENCODERS.includes(action.control) || !integer(action.delta, -128, 128) || action.delta === 0))
      invalid('choose an encoder and 1–128 steps in either direction');
    if (action.type === 'midi' && (!Array.isArray(action.data) || !action.data.length || action.data.length > 1024 ||
        !action.data.every(byte => integer(byte, 0, 255)))) invalid('data must contain 1–1024 MIDI bytes (0–255)');
    return structuredClone(action);
  });
  const script = { format: SCRIPT_FORMAT, version: 1, name: value.name.trim(), actions };
  if (new TextEncoder().encode(JSON.stringify(script)).length > MAX_SCRIPT_BYTES) throw Error('Script exceeds 1 MiB');
  return script;
}

export function parseScript(text) {
  if (new TextEncoder().encode(text).length > MAX_SCRIPT_BYTES) throw Error('Script exceeds 1 MiB');
  let value;
  try { value = JSON.parse(text); } catch { throw Error('Script must be valid JSON'); }
  return validateScript(value);
}

export function actionLabel(action) {
  switch (action.type) {
    case 'power-on': return `Power on · ${action.mode}`;
    case 'power-off': return 'Power off · waiting for firmware shutdown';
    case 'wait': return `Wait ${action.ms} ms`;
    case 'button': return `${action.down ? 'Hold' : 'Release'} ${action.control}`;
    case 'press': return `Press ${action.control} for ${action.ms} ms`;
    case 'encoder': return `Turn ${action.control} ${action.delta > 0 ? '+' : ''}${action.delta} steps`;
    case 'midi': return `Send ${action.data.length} MIDI bytes`;
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

// Use the interactive input path, including its virtual scan/debounce spacing.
// Await queued edges before advancing, while the worker continues rendering.
export async function runScript(value, { request, signal, onProgress = () => {},
  delay = sleep, now = () => performance.now(), timeout = 120000 }) {
  const script = validateScript(value);
  let snapshot;
  const check = () => {
    signal?.throwIfAborted();
    if (snapshot?.terminated) throw Error(snapshot.terminated.message);
    if (!snapshot?.loaded) throw Error('Load firmware before running a script');
    if (snapshot.locked) throw Error('Wait for the current updater or backup operation to finish');
    if (snapshot.report?.error) throw Error(snapshot.report.error);
    if (snapshot.report?.debug?.enabled) throw Error('Disable debugging before running a script');
  };
  const refresh = async () => { snapshot = await request('state'); check(); };
  const command = async (action, data) => { check(); snapshot = await request(action, data); check(); };
  const until = async (ready, message) => {
    const start = now();
    while (!ready()) {
      if (now() - start >= timeout) throw Error(message);
      await delay(25, signal);
      await refresh();
    }
  };
  const wait = async ms => {
    const end = now() + ms;
    do {
      await delay(Math.min(50, Math.max(0, end - now())), signal);
      await refresh();
    } while (now() < end);
  };
  const input = async event => {
    if (snapshot.report?.board.poweredOff) throw Error('Add a Power on action before panel or MIDI actions');
    await command('event', event);
    // Give Vue and the panel a paint opportunity, even for adjacent actions.
    await delay(25, signal);
    await refresh();
    await until(() => !snapshot.inputPending, 'Timed out waiting for firmware to process panel input');
  };
  await refresh();
  if (!snapshot.running && !snapshot.report?.board.poweredOff && script.actions[0]?.type !== 'power-on')
    await command('run');
  for (let index = 0; index < script.actions.length; index++) {
    check();
    const action = script.actions[index];
    onProgress({ index, total: script.actions.length, action, label: actionLabel(action) });
    switch (action.type) {
      case 'power-on': await command('reset', { mode: action.mode }); break;
      case 'power-off':
        if (!snapshot.report?.board.poweredOff) await command('poweroff');
        await until(() => snapshot.report?.board.poweredOff, 'Firmware did not finish powering off within two minutes');
        break;
      case 'wait': await wait(action.ms); break;
      case 'button': await input(action); break;
      case 'press':
        try {
          await input({ type: 'button', control: action.control, down: true });
          await wait(action.ms);
        } finally {
          // A cancelled timed press must not leave a button stuck down.
          if (signal?.aborted) await request('event', { type: 'button', control: action.control, down: false });
          else await input({ type: 'button', control: action.control, down: false });
        }
        break;
      case 'encoder': case 'midi': await input(action); break;
    }
  }
  onProgress({ index: script.actions.length, total: script.actions.length, action: null, label: 'Complete' });
  // Keep running unless the script explicitly requested power-off.
  return snapshot;
}
