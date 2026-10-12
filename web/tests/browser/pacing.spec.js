import {test, expect} from './fixtures.js';

test('a stalled state consumer cannot queue snapshots or prevent execution and pause', async ({page}) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.sq64Emulator);
  const result = await page.evaluate(async () => {
    window.sq64Emulator.start();
    const worker = window.sq64Emulator.worker, pending = new Map(), states = [];
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
  await page.goto('/'); await page.locator('#browser-workbench[open]').waitFor();
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

test('pad brightness transitions soften running PWM changes but paused/debug snapshots and button presses are immediate', async ({page}) => {
  await page.goto('/'); await page.locator('#browser-workbench[open]').waitFor();
  const panel = page.frameLocator('#emulator-frame');
  await panel.locator('#load-probe').click(); await expect(panel.locator('#status')).toContainText('Running');
  await page.evaluate(async () => {
    const device = window.sq64Emulator;
    window.ledState = await device.request('pause'); device.worker.terminate();
  });
  const frame = page.frames().find(f => f.url().includes('/emulator/'));
  const result = await frame.evaluate(async () => {
    const device = window.parent.sq64Emulator, state = structuredClone(window.parent.ledState);
    const pad = document.querySelector('[data-control=B1]');
    const paint = async () => {
      device.dispatchEvent(new CustomEvent('state', {detail: structuredClone(state)}));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    };
    state.panel.leds.B1 = 0; await paint();
    const dark = getComputedStyle(pad).backgroundColor;
    state.running = true; await paint(); state.panel.leds.B1 = 255; await paint();
    const transitions = pad.getAnimations();
    for (const animation of transitions) { animation.pause(); animation.currentTime = 60; }
    const halfway = getComputedStyle(pad).backgroundColor, exactLevel = pad.dataset.led;
    for (const animation of transitions) animation.finish();
    const lit = getComputedStyle(pad).backgroundColor;
    state.running = false; state.panel.leds.B1 = 0; await paint();
    const paused = {color: getComputedStyle(pad).backgroundColor, animations: pad.getAnimations().length};
    // Debugging can be running too; retain immediate visibility of every step.
    state.running = true; state.report.debug = {enabled: true, breakpoints: [], traceLimit: 256, trace: [], registers: {}, stoppedAt: null};
    state.panel.leds.B1 = 255; await paint();
    const debug = {color: getComputedStyle(pad).backgroundColor, animations: pad.getAnimations().length};
    // Disabling the debugger restores normal presentation, except while held.
    state.report.debug.enabled = false; state.panel.buttons.B1 = true; await paint();
    const pressedAnimations = pad.getAnimations().length;
    return {dark, halfway, lit, exactLevel, transitions: transitions.length, paused, debug, pressedAnimations};
  });
  expect(result.transitions).toBeGreaterThan(0);
  expect(result.halfway).not.toBe(result.dark); expect(result.halfway).not.toBe(result.lit);
  expect(result.exactLevel).toBe('255');
  expect(result.paused).toEqual({color: result.dark, animations: 0});
  expect(result.debug).toEqual({color: result.lit, animations: 0});
  expect(result.pressedAnimations).toBe(0);
  await page.emulateMedia({reducedMotion: 'reduce'});
  const reduced = await frame.evaluate(() => {
    const pad = document.querySelector('[data-control=B1]'); pad.setAttribute('aria-pressed', 'false');
    return getComputedStyle(pad).transitionDuration;
  });
  expect(reduced).toBe('0s');
});
