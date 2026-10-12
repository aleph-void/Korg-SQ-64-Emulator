import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { SCRIPT_EXAMPLES } from '../emulator/script-examples.js';
import { BUG_SCRIPT_EXAMPLES } from '../emulator/bug-script-examples.js';
import { parseScript } from '../emulator/scripts.js';

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
