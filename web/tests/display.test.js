import test from 'node:test';
import assert from 'node:assert/strict';
import {displayPixels} from '../emulator/display.js';

test('display renders low-nibble-first pixels with the observed bottom-to-top row orientation', () => {
  const frame = new Uint8Array(8192);
  frame.set([0x21, 0x43, 0x65, 0x87]);
  frame.set([0xba, 0xdc], 128); // First word of the next display row.
  const pixels = displayPixels(frame);
  assert.deepEqual(Array.from({length: 8}, (_, i) => pixels[(63 * 256 + i) * 4 + 2]), [17, 34, 51, 68, 85, 102, 119, 136]);
  assert.deepEqual(Array.from({length: 4}, (_, i) => pixels[(62 * 256 + i) * 4 + 2]), [170, 187, 204, 221]);
  assert.equal(pixels[3], 255);
  assert.throws(() => displayPixels(new Uint8Array(8191)), /frame/);
});
