"""Independent package checks. A valid package is not a device certification."""
import hashlib
import struct

REGIONS = [(0, 0x10000), (0x10000, 0x4000), (0x14000, 0xbdd8), (0x20000, 0x14000)]

def inspect(data):
    results = []
    def check(identifier, condition, detail):
        results.append({'id': identifier, 'status': 'pass' if condition else 'fail', 'detail': detail})
        return condition
    digest = hashlib.sha256(data).hexdigest()
    if not check('PKG-001', len(data) == 0x38100 and data[:16] == b'KORG SYSTEM FILE', 'Single 256-byte header plus 0x38000-byte payload'):
        return digest, results
    check('PKG-002', data[16:32] == b'SQ-64'.ljust(16, b'\0') and data[32:40] == b'SYSTEM\0\0' and data[0x29] == 0 and data[0x2c:0x30] == bytes([0, 1, 0x60, 255]), 'SQ-64 system target, block zero, no member restriction')
    check('PKG-003', struct.unpack_from('<4I', data, 0x30) == (0, 0x38000, 0, 0x38000), 'Zero base/start; exact full-image length')
    delay = struct.unpack_from('<I', data, 0x44)[0]
    check('PKG-004', data[0x2a] < 64 and data[0x2b] < 128 and (delay == 0xffffffff or delay <= 60000), 'Representable version and bounded post-update delay')
    payload = data[256:]; sp, pc = struct.unpack_from('<2I', payload)
    check('BOOT-001', 0x20000000 < sp <= 0x20040000 and sp % 8 == 0, 'Initial stack lies in SRAM and is eight-byte aligned')
    check('BOOT-002', bool(pc & 1) and 0x00200008 <= (pc & ~1) < 0x00210000, 'Reset vector points to Thumb code in internal flash')
    sums = [sum(struct.unpack_from('<' + 'H' * (length // 2), payload, start)) & 65535 for start, length in REGIONS]
    check('PKG-005', not any(sums), 'Four additive halfword checksums: ' + ', '.join(hex(s) for s in sums))
    return digest, results
