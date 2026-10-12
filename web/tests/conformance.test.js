import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {validateImage} from '../emulator/conformance/validate.js';
import {syntheticVsb} from './fixtures.js';

test('browser image reports match the pinned upstream evaluator across failures and boundaries', async () => {
  const cases = [syntheticVsb()];
  const mutate = (offset, value, width = 1) => {
    const data = syntheticVsb(), view = new DataView(data.buffer);
    if (width === 4) view.setUint32(offset, value, true); else data[offset] = value;
    cases.push(data);
  };
  for (const offset of [0, 16, 31, 32, 39, 0x29, 0x2c, 0x2d, 0x2e, 0x2f, 0x30, 0x34, 0x38, 0x3c]) mutate(offset, 17);
  for (const value of [0, 63, 64, 127, 255]) mutate(0x2a, value);
  for (const value of [0, 127, 128, 255]) mutate(0x2b, value);
  for (const value of [0, 60000, 60001, 0xfffffffe, 0xffffffff]) mutate(0x44, value, 4);
  for (const value of [0x20000000, 0x20000008, 0x20040000, 0x20040008, 0x20000001, 0xffffffff]) mutate(256, value, 4);
  for (const value of [0x200001, 0x200007, 0x200009, 0x20ffff, 0x210001, 0x200008, 0x20000001, 0xffffffff]) mutate(260, value, 4);
  // Every checksum region, plus the intentionally excluded gap and tail.
  for (const offset of [0x100, 0x10000, 0x14000, 0x1fdd7, 0x1fdd8, 0x1ffff, 0x20000, 0x33fff, 0x34000, 0x37fff]) mutate(256 + offset, 1);
  for (const length of [0, 15, 255, 256, 0x10000, 0x38000, 0x380ff, 0x38101]) cases.push(new Uint8Array(length));
  cases.push(syntheticVsb().subarray(256));
  const python = process.env.PYTHON || 'python3';
  const expected = JSON.parse(execFileSync(python, ['-c', `
import base64, json, sys
sys.path.insert(0, '..')
from sq64_emulator.conformance import validate_image
print(json.dumps([validate_image(base64.b64decode(s)) for s in json.load(sys.stdin)]))
`], {input: JSON.stringify(cases.map(data => Buffer.from(data).toString('base64'))), maxBuffer: 8 * 1024 * 1024}));
  for (let i = 0; i < cases.length; i++) assert.deepEqual(await validateImage(cases[i]), expected[i], `case ${i}`);
  assert.equal(expected[0].status, 'pass'); assert.equal(expected[0].counts.pass, 7);
  assert.equal(expected.at(-1).status, 'fail'); assert.equal(expected.at(-1).counts['not-run'], 6);
});

test('conformance copies input views and spec metadata distributions stay in sync', async () => {
  const wrapped = new Uint8Array(0x38100 + 16); wrapped.set(syntheticVsb(), 8);
  const view = wrapped.subarray(8, -8), expected = await validateImage(view);
  const pending = validateImage(view); view.fill(0);
  assert.deepEqual(await pending, expected);
  execFileSync(process.env.PYTHON || 'python3', ['../tools/sync_conformance.py', '--check']);
});
