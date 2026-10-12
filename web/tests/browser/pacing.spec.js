import {test, expect} from '@playwright/test';

test('a stalled state consumer cannot queue snapshots or prevent execution and pause', async ({page}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const worker = new Worker('/emulator/worker.js', {type: 'module'}), pending = new Map(), states = [];
    let id = 0;
    const request = (action, data = {}) => new Promise((resolve, reject) => {
      pending.set(++id, {resolve, reject}); worker.postMessage({id, action, data});
    });
    worker.onmessage = ({data}) => {
      if (data.type === 'state') states.push(data.state); // Deliberately withhold acknowledgements.
      else if (pending.has(data.id)) {
        const task = pending.get(data.id); pending.delete(data.id);
        if (data.error) task.reject(Error(data.error)); else task.resolve(data.result);
      }
    };
    const wait = () => new Promise(resolve => setTimeout(resolve, 150));
    try {
      await request('load', {bytes: await (await fetch('/examples/browser-probe.bin')).arrayBuffer(), transport: 'din'});
      const started = await request('run');
      await wait();
      const progressed = await request('state'), blocked = states.length;
      worker.postMessage({type: 'state-ack'}); await wait();
      const released = states.length, latest = states.at(-1);
      const stopped = await request('pause');
      worker.postMessage({type: 'state-ack'}); await wait();
      const paused = states.at(-1), again = await request('state');
      return {blocked, released, progressed: progressed.report.board.ticks > started.report.board.ticks,
        latestTicks: latest.report.board.ticks, progressedTicks: progressed.report.board.ticks,
        paused: paused.running, stopped: stopped.running, stable: again.report.board.ticks === stopped.report.board.ticks};
    } finally { worker.terminate(); }
  });
  expect(result.blocked).toBe(1); expect(result.released).toBe(2);
  expect(result.progressed).toBe(true); expect(result.latestTicks).toBeGreaterThanOrEqual(result.progressedTicks);
  expect(result.paused).toBe(false); expect(result.stopped).toBe(false); expect(result.stable).toBe(true);
});

test('panel paints the latest burst once and reuses an unchanged display', async ({page}) => {
  await page.goto('/'); await page.locator('#browser-workbench summary').click();
  const panel = page.frameLocator('#emulator-frame');
  await panel.locator('#load-probe').click(); await expect(panel.locator('#status')).toContainText('Running');
  await page.evaluate(async () => {
    const device = window.sq64Emulator; window.pacingState = await device.request('pause'); device.worker.terminate();
    device.dispatchEvent(new CustomEvent('state', {detail: window.pacingState}));
  });
  await expect(panel.locator('#status')).toContainText('Paused');
  const frame = page.frames().find(frame => frame.url().includes('/emulator/'));
  const result = await frame.evaluate(async () => {
    const device = window.parent.sq64Emulator, state = structuredClone(window.parent.pacingState);
    const context = document.querySelector('#display').getContext('2d'), put = context.putImageData;
    let paints = 0;
    context.putImageData = function(...args) { paints++; return put.apply(this, args); };
    const painted = () => new Promise(resolve => requestAnimationFrame(resolve));
    try {
      for (let i = 1; i <= 100; i++) {
        const snapshot = structuredClone(state); snapshot.panel.display.fill(i); snapshot.panel.leds.A1 = i;
        device.dispatchEvent(new CustomEvent('state', {detail: snapshot}));
      }
      await painted();
      const first = paints, level = document.querySelector('[data-control=A1]').dataset.led;
      state.panel.display.fill(100); state.panel.displayFrames++;
      device.dispatchEvent(new CustomEvent('state', {detail: state})); await painted();
      return {first, total: paints, level};
    } finally { context.putImageData = put; }
  });
  expect(result).toEqual({first: 1, total: 1, level: '100'});
});
