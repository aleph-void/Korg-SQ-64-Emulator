import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { SCRIPT_EXAMPLES } from '../emulator/script-examples.js';
import { BUG_SCRIPT_EXAMPLES } from '../emulator/bug-script-examples.js';
import { parseScript, runScript } from '../emulator/scripts.js';

test('bug examples are available in the catalog and their portable imports stay identical', () => {
  assert.equal(new Set(SCRIPT_EXAMPLES.map(e => e.id)).size, SCRIPT_EXAMPLES.length);
  for (const example of BUG_SCRIPT_EXAMPLES) {
    const catalog = SCRIPT_EXAMPLES.find(e => e.id === example.id);
    const text = readFileSync(new URL(`../examples/scripts/${example.id}.json`, import.meta.url), 'utf8');
    assert.deepEqual(parseScript(text), catalog.script);
    assert.ok(catalog.description.includes('boot'), 'setup must be visible before playback');
  }
  const result = spawnSync(process.execPath, [new URL('../../tools/export_bug_script_examples.mjs', import.meta.url).pathname, '--check'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

for (const { id } of BUG_SCRIPT_EXAMPLES) test(`${id} powers on and waits before panel input from an off session`, async () => {
  const script = SCRIPT_EXAMPLES.find(example => example.id === id).script;
  let time = 0;
  const calls = [], buttons = new Map();
  const state = { loaded: true, running: false, inputPending: false,
    report: { board: { poweredOff: true }, debug: { enabled: false } } };
  const result = await runScript(script, {
    async request(action, data) {
      if (action !== 'state') calls.push({ action, data, time });
      if (action === 'reset') {
        assert.deepEqual(data, { mode: 'normal' });
        state.running = true;
        state.report.board.poweredOff = false;
      } else if (action === 'event') {
        assert.equal(state.report.board.poweredOff, false, 'must power on before input');
        assert.ok(time >= 60000, 'must allow the full startup wait before input');
        if (data.type === 'button') buttons.set(data.control, data.down);
      } else assert.equal(action, 'state');
      return structuredClone(state);
    },
    async delay(ms) { time += ms || 1; },
    now: () => time,
  });
  assert.equal(calls[0].action, 'reset');
  assert.equal(calls.filter(call => call.action === 'reset').length, 1);
  assert.ok(calls.some(call => call.action === 'event'));
  assert.equal(result.running, true);
  assert.equal(result.report.board.poweredOff, false);
  assert.ok([...buttons.values()].every(down => !down), 'release all pressed controls');
});
