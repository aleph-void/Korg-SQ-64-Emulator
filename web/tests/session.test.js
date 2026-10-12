import test from 'node:test';
import assert from 'node:assert/strict';
import {MidiSession, updateFirmware} from '../src/session.js';
import {DemoSession} from '../src/demo.js';
import {frame, parseVsb, parseFrame} from '../src/protocol.js';
import {syntheticVsb} from './fixtures.js';
class Port extends EventTarget {
  state = 'connected'; sent = [];
  send(data) { this.sent.push(data); this.onSend?.(data); }
  receive(data) { const e = new Event('midimessage'); e.data = data; this.dispatchEvent(e); }
}
test('listener is installed before transmission, handles progress before ack', async () => {
  const input = new Port(), output = new Port(), s = new MidiSession(input, output);
  output.onSend = () => { input.receive(frame(0x13, [0, 1, 0, 2])); input.receive(frame(5, [0])); };
  let progress = 0;
  assert.equal(parseFrame(await s.exchange(frame(4), {progress: d => { if (d[6] === 0x13) { progress++; return true; } }})).command, 5);
  assert.equal(progress, 1); s.close();
});
test('timeout closes session and prevents a late ACK being used by another request', async () => {
  const input = new Port(), output = new Port(), s = new MidiSession(input, output, {timeout: 5});
  await assert.rejects(s.exchange(frame(4)), /timed out/);
  input.receive(frame(5, [0])); await assert.rejects(s.exchange(frame(6)), /closed/);
  assert.equal(output.sent.length, 1);
});
test('disconnect rejects pending operation and concurrent requests are refused', async () => {
  const input = new Port(), output = new Port(), s = new MidiSession(input, output);
  const first = s.exchange(frame(4)); await assert.rejects(s.exchange(frame(6)), /progress/);
  input.state = 'disconnected'; input.dispatchEvent(new Event('statechange'));
  await assert.rejects(first, /disconnected/);
});
test('complete synthetic update preserves order and never claims device completion', async () => {
  const session = new DemoSession(), states = [];
  const result = await updateFirmware(session, parseVsb(syntheticVsb()), {delay: async () => {}, onProgress: p => states.push(p.phase)});
  assert.equal(result.packets, 224); assert.equal(result.deviceCompletionVerified, false);
  assert.deepEqual(session.frames.slice(0, 3).map(d => d[6]), [0, 2, 4]);
  assert.equal(states.at(-1), 'await-device-completion'); assert.ok(states.includes('writing'));
});
test('NAK stops immediately without retry or later packets', async () => {
  const session = new DemoSession(), exchange = session.exchange.bind(session);
  session.exchange = async data => data[6] === 6 ? frame(5, [9]) : exchange(data);
  await assert.rejects(updateFirmware(session, parseVsb(syntheticVsb()), {delay: async () => {}}), /Flash write/);
  assert.equal(session.next, 0);
});
