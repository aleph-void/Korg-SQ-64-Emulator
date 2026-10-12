import test from 'node:test';
import assert from 'node:assert/strict';
import { SCRIPT_FORMAT, validateScript, parseScript, runScript } from '../emulator/scripts.js';
import { SCRIPT_EXAMPLES } from '../emulator/script-examples.js';

const script = actions => ({ format: SCRIPT_FORMAT, version: 1, name: 'Test', actions });
function fixture(overrides = {}) {
  let time = 0, pending = 0;
  const state = { loaded: true, running: true, inputPending: false,
    report: { board: { poweredOff: false }, debug: { enabled: false } }, ...overrides };
  const calls = [], progress = [];
  const options = {
    async request(action, data) {
      calls.push({ action, data });
      if (action === 'run') state.running = true;
      if (action === 'reset') { state.running = true; state.report.board.poweredOff = false; }
      if (action === 'event') { state.inputPending = true; pending = 3; }
      if (action === 'poweroff') { state.report.board.poweredOff = true; state.running = false; }
      return structuredClone(state);
    },
    async delay(ms, signal) {
      signal?.throwIfAborted();
      time += ms || 1;
      if (pending && --pending === 0) state.inputPending = false;
    },
    now: () => time,
    onProgress: value => progress.push(value),
  };
  return { options, calls, state, progress };
}

test('script validation accepts examples and isolates their nested data', () => {
  for (const example of SCRIPT_EXAMPLES) assert.deepEqual(parseScript(JSON.stringify(example.script)), example.script);
  const original = script([{ type: 'midi', data: [0x90, 60, 100] }]);
  validateScript(original).actions[0].data[0] = 0;
  assert.equal(original.actions[0].data[0], 0x90);
});

test('script imports reject unsupported versions, malformed actions, unknown controls and excessive input', () => {
  assert.throws(() => parseScript('{'), /valid JSON/);
  for (const invalid of [null, [], { ...script([]), version: 2 }, { ...script([]), name: ' ' },
    { ...script([]), unexpected: true }, script(Array(10001).fill({ type: 'power-off' })),
    ...[
      { type: 'eval', code: 'alert(1)' }, { type: '__proto__' }, { type: 'wait', ms: -1 },
      { type: 'wait', ms: 1.5 }, { type: 'wait', ms: 3600001 }, { type: 'wait', ms: 1, typo: true },
      { type: 'button', control: 'A17', down: true }, { type: 'button', control: 'play', down: 'true' },
      { type: 'encoder', control: 'tempo', delta: 129 }, { type: 'encoder', control: 'nope', delta: 1 },
      { type: 'power-on', mode: 'unknown' }, { type: 'press', control: 'play' },
      { type: 'firmware-update', allowOlder: 'true' }, { type: 'firmware-update', file: 'candidate.vsb' },
      { type: 'midi', data: [] }, { type: 'midi', data: [256] }, { type: 'midi', data: Array(1025).fill(0) },
    ].map(action => script([action])),
  ]) assert.throws(() => validateScript(invalid));
  assert.throws(() => parseScript(' '.repeat(1024 * 1024 + 1)), /1 MiB/);
});

test('validates all actions before issuing any command', async () => {
  const { options, calls } = fixture();
  await assert.rejects(runScript(script([{ type: 'power-on', mode: 'normal' }, { type: 'unknown' }]), options), /Action 2/);
  assert.deepEqual(calls, []);
});

test('actions run in order, wait for queued input, and leave the instance running', async () => {
  const { options, calls, state, progress } = fixture({ running: false });
  const actions = [{ type: 'button', control: 'shift', down: true }, { type: 'encoder', control: 'tempo', delta: 3 },
    { type: 'press', control: 'A1', ms: 100 }, { type: 'button', control: 'shift', down: false },
    { type: 'midi', data: [0x90, 60, 100] }, { type: 'wait', ms: 500 }];
  const result = await runScript(script(actions), options);
  assert.equal(result.running, true);
  assert.equal(state.report.board.poweredOff, false);
  assert.deepEqual(calls.filter(row => row.action !== 'state'), [
    { action: 'run', data: undefined },
    ...[actions[0], actions[1], { type: 'button', control: 'A1', down: true },
      { type: 'button', control: 'A1', down: false }, actions[3], actions[4]].map(data => ({ action: 'event', data })),
  ]);
  assert.ok(calls.filter(row => row.action === 'state').length >= 18, 'waits for all three input polling intervals');
  assert.equal(progress.at(-1).index, actions.length);
});

test('only explicit power-off shuts down; power-on can follow it in the same script', async () => {
  for (const restart of [false, true]) {
    const { options, calls } = fixture();
    const actions = [{ type: 'power-off' }, ...(restart ? [{ type: 'power-on', mode: 'version' }] : [])];
    const result = await runScript(script(actions), options);
    assert.equal(result.report.board.poweredOff, !restart);
    assert.deepEqual(calls.filter(row => row.action === 'poweroff').length, 1);
    assert.equal(result.running, restart);
  }
});

test('power-off waits for firmware and reports a timeout rather than claiming completion', async () => {
  const { options } = fixture();
  const request = options.request;
  options.request = (action, data) => request(action === 'poweroff' ? 'state' : action, data);
  await assert.rejects(runScript(script([{ type: 'power-off' }]), { ...options, timeout: 75 }), /did not finish powering off/);
});

test('cancelling a timed press releases it, skips remaining actions, and does not power off', async () => {
  const { options, calls, state } = fixture();
  const controller = new AbortController();
  const delay = options.delay;
  options.delay = async (ms, signal) => { controller.abort(); await delay(ms, signal); };
  await assert.rejects(runScript(script([{ type: 'press', control: 'A1', ms: 1000 }, { type: 'power-off' }]),
    { ...options, signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(calls.filter(row => row.action === 'event').map(row => row.data.down), [true, false]);
  assert.equal(state.running, true);
  assert.equal(calls.some(row => row.action === 'poweroff'), false);
});

test('faults, transaction locks, disabled firmware and debugging prevent playback', async () => {
  for (const overrides of [{ loaded: false }, { locked: true }, { terminated: { message: 'Terminated' } },
    { report: { error: 'Firmware fault' } }, { report: { debug: { enabled: true } } }]) {
    const { options, calls } = fixture(overrides);
    await assert.rejects(runScript(script([{ type: 'press', control: 'play', ms: 100 }]), options));
    assert.deepEqual(calls.map(row => row.action), ['state']);
  }
  const { options, state, calls } = fixture();
  options.delay = async () => { state.report.error = 'Firmware fault during wait'; };
  await assert.rejects(runScript(script([{ type: 'wait', ms: 100 }, { type: 'power-off' }]), options), /during wait/);
  assert.equal(calls.some(row => row.action === 'poweroff'), false);
});

test('update scripts require a selected image before any actions, including power-on', async () => {
  const { options, calls } = fixture();
  await assert.rejects(runScript(script([{ type: 'power-on', mode: 'update' }, { type: 'firmware-update' }]), options), /Select an update VSB/);
  assert.deepEqual(calls, []);
});

test('update action awaits transfer, forwards cancellation/progress and uses an explicit downgrade setting', async () => {
  for (const allowOlder of [undefined, false, true]) {
    const { options, calls, progress } = fixture();
    const controller = new AbortController();
    const action = { type: 'firmware-update', ...(allowOlder === undefined ? {} : { allowOlder }) };
    const result = await runScript(script([action, { type: 'power-off' }]), { ...options, signal: controller.signal,
      async firmwareUpdate(action, context) {
        assert.deepEqual(action, { allowOlder: allowOlder ?? false });
        assert.equal(context.signal, controller.signal);
        assert.equal(calls.some(call => call.action === 'poweroff'), false);
        context.onProgress({ phase: 'transmitting', done: 10, total: 224 });
      } });
    assert.equal(result.report.board.poweredOff, true);
    assert.ok(progress.some(row => row.label.includes('10/224')));
  }
});

test('failed or cancelled update skips all remaining script actions', async () => {
  for (const cancel of [false, true]) {
    const { options, calls } = fixture();
    const controller = new AbortController();
    await assert.rejects(runScript(script([{ type: 'firmware-update' }, { type: 'power-off' }]), {
      ...options, signal: controller.signal, async firmwareUpdate() {
        if (cancel) { controller.abort(); controller.signal.throwIfAborted(); }
        throw Error('Transfer failed');
      },
    }));
    assert.equal(calls.some(call => call.action === 'poweroff'), false);
  }
});
