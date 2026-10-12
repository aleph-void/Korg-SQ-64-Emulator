// Port of sq64_spec/image.py and report.evaluate(profile='image') at the
// revision recorded in spec.js. Upstream MIT license is included in LICENSE.
// Keep all seven results and early-exit/not-run behavior identical to upstream.
import spec from './spec.js';
import {sha256} from '../../src/protocol.js';

export async function validateImage(input) {
  // Copy before the async digest so callers cannot change the checked bytes.
  const data = new Uint8Array(input).slice(), imageSha256 = await sha256(data);
  const checks = new Map();
  const check = (id, condition, detail) => {
    checks.set(id, {id, status: condition ? 'pass' : 'fail', detail, provenance: 'executed image check'});
    return condition;
  };
  const text = (start, end) => new TextDecoder().decode(data.subarray(start, end));
  if (check('PKG-001', data.length === 0x38100 && text(0, 16) === 'KORG SYSTEM FILE', 'Single 256-byte header plus 0x38000-byte payload')) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    check('PKG-002', text(16, 32) === 'SQ-64'.padEnd(16, '\0') && text(32, 40) === 'SYSTEM\0\0' && data[0x29] === 0 && [0, 1, 0x60, 255].every((b, i) => data[0x2c + i] === b), 'SQ-64 system target, block zero, no member restriction');
    check('PKG-003', [0, 0x38000, 0, 0x38000].every((n, i) => view.getUint32(0x30 + i * 4, true) === n), 'Zero base/start; exact full-image length');
    const delay = view.getUint32(0x44, true);
    check('PKG-004', data[0x2a] < 64 && data[0x2b] < 128 && (delay === 0xffffffff || delay <= 60000), 'Representable version and bounded post-update delay');
    const sp = view.getUint32(256, true), pc = view.getUint32(260, true);
    check('BOOT-001', sp > 0x20000000 && sp <= 0x20040000 && sp % 8 === 0, 'Initial stack lies in SRAM and is eight-byte aligned');
    check('BOOT-002', !!(pc & 1) && (pc & ~1) >= 0x00200008 && (pc & ~1) < 0x00210000, 'Reset vector points to Thumb code in internal flash');
    const sums = [[0, 0x10000], [0x10000, 0x4000], [0x14000, 0xbdd8], [0x20000, 0x14000]].map(([start, length]) => {
      let sum = 0;
      for (let i = start; i < start + length; i += 2) sum = (sum + view.getUint16(256 + i, true)) & 65535;
      return sum;
    });
    check('PKG-005', sums.every(n => n === 0), 'Four additive halfword checksums: ' + sums.map(n => '0x' + n.toString(16)).join(', '));
  }
  const results = spec.requirements.map(r => checks.get(r.id) || {id: r.id, status: 'not-run', detail: r.verification});
  const counts = Object.fromEntries(['pass', 'fail', 'not-run'].map(status => [status, results.filter(r => r.status === status).length]));
  return {
    format: 'sq64-conformance-report', version: 2, specVersion: spec.specVersion,
    profile: 'image', imageSha256, status: counts.fail ? 'fail' : counts['not-run'] ? 'incomplete' : 'pass', results,
    modelContractSha256: spec.modelContractSha256, counts, releaseBlockers: [], contexts: {}, declaration: null,
    claim: 'Bounded checks for the named profile; not proof for every input or event schedule',
    hardwareValidated: false, externalEvidenceAccepted: false,
    specSource: {...spec.specSource}, inputScope: 'loaded-file',
  };
}
