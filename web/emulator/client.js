import {criticalStop} from './conformance/safety.js';

class LocalPort extends EventTarget {
  constructor() { super(); this.state = 'disconnected'; }
  setState(state) { if (this.state !== state) { this.state = state; this.dispatchEvent(new Event('statechange')); } }
}
export class BrowserEmulator extends EventTarget {
  constructor() {
    super(); this.input = new LocalPort(); this.output = new LocalPort(); this.pending = new Map(); this.nextId = 0; this.loaded = false; this.locked = false;
    this.output.send = data => {
      if (!this.loaded || this.output.state !== 'connected') throw Error('Browser emulator is not connected');
      this.request('midi', Uint8Array.from(data)).catch(error => this.fault(error.message));
    };
  }
  start() {
    if (this.terminated) throw Error(this.terminated.message);
    if (this.worker) return;
    this.worker = new Worker(new URL('./worker.js', import.meta.url), {type: 'module'});
    const worker = this.worker;
    this.worker.onerror = e => { if (this.worker === worker) this.fault(e.message || 'Emulator worker failed'); };
    this.worker.onmessage = ({data: m}) => {
      if (this.terminated || this.worker !== worker) return;
      const snapshot = m.state || (typeof m.result?.loaded === 'boolean' ? m.result : null);
      const stop = snapshot && (snapshot.terminated || criticalStop(snapshot.report?.critical) || criticalStop(snapshot.report?.conformance));
      if (stop) { this.terminate(snapshot, stop); return; }
      if (m.type === 'midi') { const event = new Event('midimessage'); event.data = m.data; this.input.dispatchEvent(event); }
      else if (m.type === 'fault') this.fault(m.error);
      else if (m.type === 'state') {
        // Bound periodic snapshots to one in flight if the UI thread stalls.
        this.worker.postMessage({type: 'state-ack'});
        this.state = {...m.state, locked: this.locked}; this.loaded = m.state.loaded;
        this.input.setState(this.loaded && !m.state.report?.error && !m.state.report?.board.poweredOff ? 'connected' : 'disconnected'); this.output.setState(this.input.state);
        this.dispatchEvent(new CustomEvent('state', {detail: this.state}));
      } else if (this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id); clearTimeout(p.timer);
        if (m.error) p.reject(Error(m.error)); else p.resolve(m.result);
      }
    };
  }
  terminate(snapshot, stop) {
    if (this.terminated) return;
    this.terminated = structuredClone(stop);
    this.worker?.terminate(); this.worker = null;
    this.loaded = false;
    this.state = structuredClone({...snapshot, running: false, terminated: stop, locked: this.locked,
      report: {...snapshot.report, status: 'terminated'}});
    this.input.setState('disconnected'); this.output.setState('disconnected');
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      if (['validate', 'state'].includes(p.action)) p.resolve(structuredClone(this.state));
      else p.reject(Error(stop.message));
    }
    this.pending.clear();
    this.dispatchEvent(new CustomEvent('state', {detail: this.state}));
    this.dispatchEvent(new CustomEvent('fault', {detail: stop.message}));
  }
  fault(message) {
    this.input.setState('disconnected'); this.output.setState('disconnected');
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Error(message)); } this.pending.clear();
    this.dispatchEvent(new CustomEvent('fault', {detail: message}));
  }
  request(action, data = {}) {
    if (this.terminated) return action === 'state'
      ? Promise.resolve(structuredClone(this.state)) : Promise.reject(Error(this.terminated.message));
    this.start(); const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error('Emulator operation timed out')); }, 30000);
      this.pending.set(id, {resolve, reject, timer, action}); this.worker.postMessage({id, action, data});
    });
  }
  setLocked(value) { this.locked = value; if (this.state) this.dispatchEvent(new CustomEvent('state', {detail: {...this.state, locked: value}})); }
  close() { this.worker?.terminate(); this.worker = null; this.loaded = false; this.fault('Emulator closed'); }
}
