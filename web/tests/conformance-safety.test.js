import test from 'node:test';
import assert from 'node:assert/strict';
import {criticalStop} from '../emulator/conformance/safety.js';
import {BrowserEmulator} from '../emulator/client.js';
import {validateImage} from '../emulator/conformance/validate.js';
import spec from '../emulator/conformance/spec.js';
import {syntheticVsb} from './fixtures.js';

const detector = {id: 'DAMAGE-001', severity: 'critical', unsafeWhen: 'pass', status: 'pass', detail: 'Synthetic damage detection'};
const report = results => ({status: 'fail', imageSha256: 'candidate-hash', results});

test('only explicitly marked critical passes terminate, regardless of overall report status', () => {
  for (const row of [
    {...detector, status: 'fail'}, {...detector, status: 'not-run'},
    {...detector, severity: 'warning'}, {...detector, severity: undefined},
    {...detector, unsafeWhen: undefined}, {...detector, unsafeWhen: 'fail'},
    {id: 'ordinary', status: 'pass'},
  ]) assert.equal(criticalStop(report([row])), null);
  assert.equal(criticalStop(null), null);
  const stop = criticalStop(report([{id: 'ordinary', status: 'fail'}, detector]));
  assert.deepEqual(stop.tests, [detector]);
  assert.equal(stop.imageSha256, 'candidate-hash');
  assert.match(stop.message, /Do not flash this firmware to a real device/);
  assert.deepEqual(criticalStop(report([detector, {...detector, id: 'DAMAGE-002'}])).tests.map(row => row.id), ['DAMAGE-001', 'DAMAGE-002']);
});

test('image validation preserves safety annotations from the synced catalog', async () => {
  const requirement = spec.requirements.find(row => row.id === 'PKG-001');
  Object.assign(requirement, {severity: 'critical', unsafeWhen: 'pass'});
  try {
    const checked = await validateImage(syntheticVsb());
    assert.deepEqual(criticalStop(checked).tests.map(row => row.id), ['PKG-001']);
    assert.equal(criticalStop(await validateImage(new Uint8Array())), null);
  } finally { delete requirement.severity; delete requirement.unsafeWhen; }
});

test('client terminates on asynchronous or response reports, drains requests and never restarts', async t => {
  for (const kind of ['terminated', 'state', 'response']) await t.test(kind, async t => {
    const workers = [];
    class Worker {
      constructor() { this.messages = []; workers.push(this); }
      postMessage(message) { this.messages.push(message); }
      terminate() { this.stopped = true; }
      receive(data) { this.onmessage({data}); }
    }
    t.mock.method(globalThis, 'setTimeout', () => 0);
    t.mock.method(globalThis, 'clearTimeout', () => {});
    const previous = globalThis.Worker; globalThis.Worker = Worker;
    t.after(() => { if (previous) globalThis.Worker = previous; else delete globalThis.Worker; });
    const device = new BrowserEmulator(), events = [];
    device.addEventListener('state', event => events.push(event.detail));
    const normal = {loaded: true, running: true, report: {board: {}, conformance: report([{id: 'ordinary', status: 'pass'}])}};
    const validation = device.request('validate');
    const worker = workers[0]; worker.receive({type: 'state', state: normal});
    assert.equal(device.input.state, 'connected');
    const queued = device.request('step', {instructions: 1});
    const rejected = assert.rejects(queued, /Do not flash/);
    const terminal = {...normal, report: {...normal.report, conformance: report([detector])}};
    if (kind === 'terminated') terminal.terminated = criticalStop(terminal.report.conformance);
    worker.receive(kind === 'response' ? {id: worker.messages[0].id, result: terminal} : {type: kind, state: terminal});
    const stopped = await validation; await rejected;
    assert.equal(stopped.running, false);
    assert.equal(stopped.report.status, 'terminated');
    assert.equal(worker.stopped, true); assert.equal(device.worker, null);
    assert.equal(device.input.state, 'disconnected'); assert.equal(device.output.state, 'disconnected');
    assert.equal(device.pending.size, 0);
    for (const action of ['run', 'step', 'reset', 'load', 'midi', 'event', 'replay', 'debug', 'validate']) {
      await assert.rejects(device.request(action), /Do not flash/);
    }
    assert.throws(() => device.output.send([0x90, 60, 100]), /not connected/);
    worker.receive({type: 'state', state: normal}); // Stale messages cannot revive the session.
    assert.equal(events.at(-1).terminated.reason, 'critical-conformance-pass');
    const snapshot = await device.request('state'); snapshot.report.conformance.results.length = 0;
    assert.equal((await device.request('state')).report.conformance.results.length, 1);
    device.setLocked(false); device.close();
    await assert.rejects(device.request('load'), /Do not flash/);
    assert.equal(workers.length, 1);
  });
});
