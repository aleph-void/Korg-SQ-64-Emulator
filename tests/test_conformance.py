import hashlib
import http.client
import json
import struct
import threading
import unittest

from sq64_emulator.conformance import validate_image
from sq64_emulator.server import Workbench, make_server
from helpers import image


def package():
    """Original synthetic loop firmware, never deployable on hardware."""
    data = bytearray(0x38100)
    data[:16] = b'KORG SYSTEM FILE'
    data[16:21] = b'SQ-64'; data[32:38] = b'SYSTEM'
    data[0x2c:0x30] = bytes([0, 1, 96, 255])
    struct.pack_into('<4I', data, 0x30, 0, 0x38000, 0, 0x38000)
    data[256:256 + 65536] = image(bytes.fromhex('0130fde7'))
    checksum = sum(struct.unpack_from('<32768H', data, 256)) & 65535
    struct.pack_into('<H', data, 256 + 65534, -checksum & 65535)
    return bytes(data)


class ConformanceTests(unittest.TestCase):
    def test_image_profile_is_upstream_and_bound_to_the_exact_file(self):
        data = package(); report = validate_image(data)
        self.assertEqual(report['status'], 'pass')
        self.assertEqual(report['counts'], {'pass': 7, 'fail': 0, 'not-run': 0})
        self.assertEqual(report['imageSha256'], hashlib.sha256(data).hexdigest())
        self.assertFalse(report['hardwareValidated'])
        self.assertEqual(report['specVersion'], '0.2.0')
        self.assertEqual(report['inputScope'], 'loaded-file')
        for offset, identifier in [(16, 'PKG-002'), (0x30, 'PKG-003'), (0x2a, 'PKG-004'),
                                   (256, 'BOOT-001'), (260, 'BOOT-002'), (0x110, 'PKG-005')]:
            bad = bytearray(data); bad[offset] ^= 0x40 if offset == 0x2a else 1
            rows = {r['id']: r['status'] for r in validate_image(bad)['results']}
            self.assertEqual(rows[identifier], 'fail')
        raw = validate_image(image())
        self.assertEqual(raw['counts'], {'pass': 0, 'fail': 1, 'not-run': 6})

    def test_native_validation_preserves_debugger_and_report_lifecycle(self):
        work = Workbench(package()); server = None
        try:
            server = make_server(work)
            thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
            connection = http.client.HTTPConnection('127.0.0.1', server.server_port)
            connection.request('GET', '/api/session')
            token = json.loads(connection.getresponse().read())['token']

            def post(name, data=None):
                body = data if isinstance(data, bytes) else json.dumps(data or {})
                connection.request('POST', '/api/' + name, body, {'X-Session-Token': token})
                response = connection.getresponse()
                return response.status, json.loads(response.read())

            post('debug', {'enabled': True, 'breakpoints': ['0x200008']})
            post('step', {'instructions': 10})  # Hit breakpoint before execution.
            post('step', {'instructions': 1})
            post('step', {'instructions': 10})  # Loop back with trace retained.
            before = post('state')[1]
            code, after = post('validate')
            self.assertEqual(code, 200)
            report = after['report']['conformance']
            self.assertEqual(report, validate_image(package()))
            after['report']['conformance'] = None
            self.assertEqual(after, before)
            self.assertEqual(post('state')[1]['report']['conformance'], report)
            self.assertEqual(post('reset', {'mode': 'normal'})[1]['report']['conformance'], report)
            self.assertEqual(post('validate')[1]['report']['conformance'], report)
            # Failed replacement leaves both the current image and validation intact.
            self.assertEqual(post('load', b'invalid')[0], 400)
            self.assertEqual(post('state')[1]['report']['conformance'], report)
            self.assertIsNone(post('load', image())[1]['report']['conformance'])
            self.assertEqual(post('validate')[1]['report']['conformance']['status'], 'fail')
            connection.close()
        finally:
            if server: server.shutdown(); server.server_close()
            work.close()
