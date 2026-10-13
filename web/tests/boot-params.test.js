import test from 'node:test';
import assert from 'node:assert/strict';
import { BOOT_TOOLS, parseBootParams, forwardedBootQuery } from '../emulator/boot-params.js';

test('parses firmware, script and tool deep-link parameters', () => {
  const boot = parseBootParams('?firmware=euclid&script=Demo%20groove&tool=scripts');
  assert.deepEqual(boot, { firmware: 'euclid', script: 'Demo groove', tool: 'scripts', errors: [] });
});

test('a plain page load carries no boot parameters', () => {
  assert.deepEqual(parseBootParams(''), { firmware: '', script: '', tool: '', errors: [] });
  assert.deepEqual(parseBootParams('?workspace=tools&utm_source=x'), { firmware: '', script: '', tool: '', errors: [] });
});

test('trims values and accepts every workbench tool tab', () => {
  assert.equal(parseBootParams('?firmware=%20probe%20').firmware, 'probe');
  for (const tool of BOOT_TOOLS) assert.equal(parseBootParams(`?tool=${tool}`).tool, tool);
});

test('rejects overlong values and unknown tools with a readable error', () => {
  const firmware = parseBootParams(`?firmware=${'a'.repeat(41)}`);
  assert.equal(firmware.firmware, '');
  assert.match(firmware.errors[0], /firmware parameter/);
  const script = parseBootParams(`?firmware=euclid&script=${'a'.repeat(121)}`);
  assert.equal(script.script, '');
  assert.match(script.errors[0], /script parameter/);
  const tool = parseBootParams('?tool=settings');
  assert.equal(tool.tool, '');
  assert.match(tool.errors[0], /tool parameter must be one of/);
});

test('a script parameter requires a firmware parameter', () => {
  const boot = parseBootParams('?script=Demo');
  assert.equal(boot.script, '');
  assert.match(boot.errors[0], /needs a firmware parameter/);
});

test('forwards only boot parameters to the embedded workbench', () => {
  assert.equal(forwardedBootQuery('?workspace=tools'), '');
  assert.equal(forwardedBootQuery('?firmware=euclid&workspace=emulator&script=Demo+groove'),
    '?firmware=euclid&script=Demo+groove');
});
