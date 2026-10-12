import test from 'node:test';
import assert from 'node:assert/strict';
import { submitFirmware } from '../emulator/firmware-update.js';
import { DemoSession } from '../src/demo.js';
import { frame } from '../src/protocol.js';
import { syntheticVsb } from './fixtures.js';

function fixture(overrides = {}) {
  const device = new EventTarget(), peer = new DemoSession(), calls = [], locks = [], progress = [];
  const state = { loaded: true, mode: 'update', running: true, transport: 'usb',
    report: { board: { poweredOff: false, usb: { phase: 'configured' } }, debug: { enabled: false } }, ...overrides };
  device.input = new EventTarget(); device.input.state = 'connected';
  device.output = new EventTarget(); device.output.state = 'connected';
  device.output.send = data => {
    peer.exchange(data).then(reply => {
      const event = new Event('midimessage'); event.data = reply; device.input.dispatchEvent(event);
    });
  };
  device.setUpdating = value => { device.updating = value; locks.push(value); };
  device.request = async action => { calls.push(action); if (action === 'run') state.running = true; return structuredClone(state); };
  const options = { delay: async () => {}, onProgress: row => progress.push(row) };
  return { device, peer, calls, locks, state, options, progress };
}

test('submits all 224 packets through MIDI without loading, resetting or directly writing the booted image', async () => {
  const { device, peer, calls, locks, options, progress } = fixture({ running: false });
  const result = await submitFirmware(device, syntheticVsb(), options);
  assert.deepEqual(result, { packets: 224, deviceCompletionVerified: false });
  assert.deepEqual(calls, ['state', 'run', 'prepare-update']);
  assert.deepEqual(locks, [true, false]);
  assert.deepEqual(peer.frames.slice(0, 3).map(data => data[6]), [0, 2, 4]);
  assert.equal(peer.next, 224);
  assert.equal(progress[0].phase, 'waiting-for-updater');
  assert.equal(progress.at(-1).phase, 'await-device-completion');
});

test('rejects invalid files, inactive updater, faults, debug, and competing operations without MIDI', async () => {
  for (const override of [{ loaded: false }, { mode: 'normal' }, { terminated: { message: 'Critical stop' } },
    { report: { board: { poweredOff: true } } }, { report: { error: 'Fault' } }, { report: { debug: { enabled: true } } }]) {
    const { device, peer, options } = fixture(override);
    await assert.rejects(submitFirmware(device, syntheticVsb(), options));
    assert.equal(peer.frames.length, 0); assert.equal(device.updating, false);
  }
  for (const key of ['locked', 'scripting', 'updating']) {
    const { device, peer, options, locks } = fixture(); device[key] = true;
    await assert.rejects(submitFirmware(device, syntheticVsb(), options), /Wait for/);
    assert.equal(peer.frames.length, 0); assert.deepEqual(locks, []);
  }
  const { device, calls, locks } = fixture();
  await assert.rejects(submitFirmware(device, new Uint8Array()), /VSB/);
  assert.deepEqual(calls, []); assert.deepEqual(locks, []);
});

test('script-owned transfers are allowed and same-version updates require explicit opt-in', async () => {
  for (const allowOlder of [false, true]) {
    const { device, peer, options } = fixture(); device.scripting = true;
    const data = syntheticVsb(); data[0x2b] = 3;
    const transfer = submitFirmware(device, data, { ...options, scripted: true, allowOlder });
    if (allowOlder) { await transfer; assert.equal(peer.next, 224); }
    else { await assert.rejects(transfer, /Same or older/); assert.deepEqual(peer.frames.map(data => data[6]), [0, 2]); }
    assert.equal(device.updating, false);
  }
});

test('waits for USB configuration before discovery and times out without sending or retrying', async () => {
  for (const ready of [false, true]) {
    const { device, state, peer, options } = fixture();
    state.report.board.usb.phase = 'enumeration';
    let time = 0;
    const transfer = submitFirmware(device, syntheticVsb(), { ...options, timeout: 100, now: () => time,
      delay: async ms => {
        time += ms;
        if (state.report.board.usb.phase !== 'configured') assert.equal(peer.frames.length, 0);
        if (ready && time >= 50) state.report.board.usb.phase = 'configured';
      } });
    if (ready) { await transfer; assert.equal(peer.next, 224); }
    else { await assert.rejects(transfer, /Timed out waiting/); assert.equal(peer.frames.length, 0); }
    assert.equal(device.updating, false);
  }
});

test('Stop cancels connection waiting, pending acknowledgements and packet delays, then releases the lock', async () => {
  for (const phase of ['waiting', 'ack', 'delay']) {
    const { device, state, peer, options } = fixture();
    const controller = new AbortController();
    if (phase === 'waiting') state.report.board.usb.phase = 'enumeration';
    if (phase === 'ack') device.output.send = () => controller.abort();
    const transfer = submitFirmware(device, syntheticVsb(), { ...options, signal: controller.signal,
      delay: async () => { controller.abort(); } });
    await assert.rejects(transfer, { name: 'AbortError' });
    assert.equal(peer.next, 0); assert.equal(device.updating, false);
  }
});

test('NAK, missing acknowledgement and emulator fault stop immediately and release the lock', async () => {
  for (const reason of ['nak', 'timeout', 'fault']) {
    const { device, peer, options } = fixture();
    const send = device.output.send;
    device.output.send = data => {
      if (![6, 8].includes(data[6])) return send(data);
      if (reason === 'nak') {
        const event = new Event('midimessage'); event.data = frame(5, [9]); device.input.dispatchEvent(event);
      } else if (reason === 'fault') device.dispatchEvent(new CustomEvent('fault', { detail: 'Critical stop' }));
    };
    await assert.rejects(submitFirmware(device, syntheticVsb(), { ...options, responseTimeout: 10 }),
      reason === 'nak' ? /Flash write/ : reason === 'timeout' ? /timed out/ : /Critical stop/);
    assert.equal(peer.next, 0); assert.equal(device.updating, false);
  }
});
