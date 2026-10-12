import test from 'node:test';
import assert from 'node:assert/strict';
import {pack, unpack, frame, parseFrame, Framer, parseVsb, integer, decodeInteger, discovery, ack, transferPlan, hex, unhex, CHECKSUM_REGIONS} from '../src/protocol.js';
import {syntheticVsb} from './fixtures.js';
test('packing round-trips all bytes and every partial group', () => {
  for (let length = 0; length < 1032; length++) {
    const input = Uint8Array.from({length}, (_, i) => i & 255);
    assert.deepEqual(unpack(pack(input), length), input);
    assert.ok(pack(input).every(b => b < 128));
  }
});
test('noncanonical packing and invalid integer encodings are rejected', () => {
  assert.throws(() => unpack(Uint8Array.of(127, 1), 1));
  assert.throws(() => unpack(Uint8Array.of(0, 128), 1));
  for (const n of [-1, 2 ** 28, .5, NaN]) assert.throws(() => integer(n));
  for (const n of [0, 127, 128, 1024, 2 ** 28 - 1]) assert.equal(decodeInteger(integer(n)), n);
  assert.throws(() => decodeInteger([0, 128]));
  assert.throws(() => unhex('a')); assert.throws(() => unhex('zz'));
  assert.equal(hex(unhex('abCD')), 'abcd');
});
test('framing tolerates fragmented messages and realtime interleaving', () => {
  const f = new Framer(), msg = frame(2, [0]); let results = [];
  for (const b of msg) results.push(...f.feed([b, 0xf8]));
  assert.deepEqual(results, [msg]);
  assert.deepEqual(f.feed([0xf0, 1, 0x90, 0xf7]), []);
  assert.throws(() => new Framer(3).feed([0xf0, 1, 2, 3]));
  assert.throws(() => frame(1, [128]));
  assert.throws(() => parseFrame(Uint8Array.of(0xf0, 0xf7)));
});
test('single-block image validates geometry, vectors and all four checksums', () => {
  const input = syntheticVsb(), pkg = parseVsb(input);
  assert.equal(pkg.payload.length, 0x38000); assert.deepEqual(pkg.version, [2, 4]);
  for (const [offset] of CHECKSUM_REGIONS) { const bad = input.slice(); bad[256 + offset + 22] ^= 1; assert.throws(() => parseVsb(bad), /checksum/); }
  for (const offset of [0, 16, 32, 0x29, 0x2c, 0x2f, 0x30, 0x34, 0x38, 0x3c]) { const bad = input.slice(); bad[offset] ^= 1; assert.throws(() => parseVsb(bad)); }
  assert.throws(() => parseVsb(input.slice(0, -1)));
  assert.throws(() => parseVsb(new Uint8Array([...input, 0])));
  const bad = input.slice(); bad[0x2a] = 64; assert.throws(() => parseVsb(bad));
});
test('transfer uses seven-bit protocol, checksum and fill capability', () => {
  const pkg = parseVsb(syntheticVsb()), caps = discovery(frame(1, [1, ...integer(4096), 7]));
  assert.equal(caps.packetSize, 1024);
  const plan = transferPlan(pkg, caps, [2, 3]);
  assert.equal(plan.count, 224);
  assert.deepEqual(Array.from(parseFrame(plan.begin).body), [0, 0, ...integer(0), ...integer(0x38000), 0x42, 4, ...integer(1024)]);
  const first = parseFrame(plan.packet(0)); assert.equal(first.command, 6);
  assert.equal(first.body.at(-1), first.body.slice(4, -1).reduce((n, b) => n + b, 0) & 127);
  assert.equal(parseFrame(plan.packet(2)).command, 8);
  assert.throws(() => plan.packet(224));
  assert.throws(() => transferPlan(pkg, caps, [2, 4]));
  assert.equal(transferPlan(pkg, caps, [3, 0], true).count, 224);
  assert.throws(() => transferPlan(pkg, {...caps, packetSize: 1000}, [2, 3]));
  const legacy = transferPlan(pkg, {protocol: 0, packetSize: 1024, flags: 0}, [2, 3]);
  assert.equal(parseFrame(legacy.begin).body.length, 4);
});
test('discovery and acknowledgements fail closed on malformed and error replies', () => {
  assert.throws(() => discovery(frame(1, [2, 0, 0])));
  assert.throws(() => discovery(frame(1, [1, 0, 0, 0, 0, 0])));
  for (let code = 1; code < 12; code++) assert.throws(() => ack(frame(5, [code])));
  assert.throws(() => ack(frame(5, [])));
  assert.equal(ack(frame(0x13, [0, 1, 0, 2])).done, 1);
});

test('VSB parsing honors nonzero offsets in Node buffers', () => {
  const source=syntheticVsb(), storage=Buffer.alloc(source.length+31);storage.set(source,17);
  const parsed=parseVsb(storage.subarray(17,17+source.length));assert.equal(parsed.payload.length,0x38000);assert.deepEqual(parsed.version,[2,4]);
});
