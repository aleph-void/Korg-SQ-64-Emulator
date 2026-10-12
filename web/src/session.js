import {Framer, VUP, frame, discovery, versionReply, ack, transferPlan} from './protocol.js';

export const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, {once: true});
});
export class MidiSession {
  constructor(input, output, {timeout = 5000} = {}) {
    this.input = input; this.output = output; this.timeout = timeout; this.pending = null; this.closed = false;
    this.framer = new Framer();
    this.receive = event => {
      try {
        for (const message of this.framer.feed(event.data)) {
          const pending = this.pending;
          if (pending && pending.matches(message)) {
            if (pending.progress?.(message)) continue;
            this.settle(null, message);
          }
        }
      } catch (error) { this.close(error); }
    };
    this.state = () => {
      if (input.state === 'disconnected' || output.state === 'disconnected') this.close(Error('Device disconnected. Keep device power connected and inspect its display.'));
    };
    input.addEventListener('midimessage', this.receive);
    input.addEventListener('statechange', this.state);
    output.addEventListener('statechange', this.state);
  }
  settle(error, value) {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null; clearTimeout(pending.timer);
    if (error) pending.reject(error); else pending.resolve(value);
  }
  exchange(message, {matches, progress, timeout = this.timeout} = {}) {
    if (this.closed) return Promise.reject(Error('MIDI session is closed; reconnect before continuing'));
    if (this.pending) return Promise.reject(Error('Another MIDI request is in progress'));
    return new Promise((resolve, reject) => {
      this.pending = {resolve, reject, matches: matches || (data => VUP.every((b, i) => data[i] === b)), progress};
      this.pending.timer = setTimeout(() => this.close(Error('Device response timed out. The operation was not retried. Reconnect after checking the device.')), timeout);
      try { this.output.send(message); } catch (error) { this.close(error); }
    });
  }
  close(error = Error('MIDI session closed')) {
    this.settle(error); this.closed = true;
    this.input.removeEventListener('midimessage', this.receive);
    this.input.removeEventListener('statechange', this.state);
    this.output.removeEventListener('statechange', this.state);
  }
}
export async function inspectUpdater(session) {
  const caps = discovery(await session.exchange(frame(0)));
  const version = versionReply(await session.exchange(frame(2, [0])));
  return {caps, version};
}
export async function updateFirmware(session, pkg, {allowOlder = false, onProgress = () => {}, delay = sleep, signal} = {}) {
  signal?.throwIfAborted();
  const abort = () => session.close(signal.reason);
  signal?.addEventListener('abort', abort, {once: true});
  let began = false;
  try {
    const {caps, version} = await inspectUpdater(session);
    signal?.throwIfAborted();
    const plan = transferPlan(pkg, caps, version, allowOlder);
    const exchange = async message => {
      signal?.throwIfAborted();
      const reply = await session.exchange(message, {progress: data => {
        const status = ack(data);
        if (status.progress) onProgress({phase: 'writing', ...status});
        return status.progress;
      }});
      ack(reply);
    };
    onProgress({phase: 'begin', version});
    began = true;
    await exchange(plan.begin);
    for (let i = 0; i < plan.count; i++) {
      await delay(2, signal);
      await exchange(plan.packet(i));
      onProgress({phase: 'transmitting', done: i + 1, total: plan.count});
    }
    if (pkg.delay) await delay(pkg.delay, signal);
    signal?.throwIfAborted();
    onProgress({phase: 'await-device-completion', done: plan.count, total: plan.count});
    return {packets: plan.count, deviceCompletionVerified: false};
  } catch (error) {
    if (began) session.close(error);
    signal?.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
