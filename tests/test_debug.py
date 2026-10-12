import json
import http.client
from pathlib import Path
import subprocess
import struct
import sys
import tempfile
import threading
import time
import unittest
from sq64_emulator.core import Machine
from sq64_emulator.server import Workbench, make_server
from helpers import image

CODE = bytes.fromhex('0130fde7')  # ADDS R0, #1; B back to ADDS.

class DebugTests(unittest.TestCase):
    def test_opt_in_breakpoint_step_continue_and_bounded_trace(self):
        m = Machine(image(CODE))
        self.assertEqual(m.report()['debug'], {'enabled': False})
        with self.assertRaises(ValueError): m.debug.memory(0x200008, 4)
        m.debug.configure(enabled=True, breakpoints=['0x200009'])
        r = m.run(20)
        self.assertEqual(r['status'], 'breakpoint'); self.assertEqual(r['board']['ticks'], 0)
        self.assertEqual(r['debug']['registers']['R0'], 0); self.assertEqual(r['debug']['trace'], [])
        r = m.run(1)
        self.assertEqual(r['pc'], 0x20000a); self.assertEqual(r['debug']['registers']['R0'], 1)
        r = m.run(20)
        self.assertEqual(r['status'], 'breakpoint'); self.assertEqual(r['board']['ticks'], 2)
        r = m.run(20)
        self.assertEqual(r['status'], 'breakpoint'); self.assertEqual(r['debug']['registers']['R0'], 2)
        m.debug.configure(breakpoints=[], traceLimit=2); r = m.run(6)
        self.assertEqual(len(r['debug']['trace']), 2); self.assertEqual(r['debug']['trace'][0]['tick'], 8)
        self.assertEqual(r['debug']['trace'][0]['bytes'], [1, 0x30])
        m.debug.configure(traceLimit=0); self.assertEqual(m.run(2)['debug']['trace'], [])
        m.debug.configure(enabled=False); self.assertEqual(m.run(2)['debug'], {'enabled': False})

    def test_validation_and_memory_inspection_do_not_mutate_cpu_or_peripherals(self):
        m = Machine(image(CODE), debug={'enabled': True})
        for options in [{'enabled': 1}, {'traceLimit': -1}, {'traceLimit': 4097}, {'breakpoints': [-1]}, {'breakpoints': [0x40000000]}, {'breakpoints': [0xffffffff]}, {'breakpoints': [0x200008] * 65}]:
            with self.subTest(options=options), self.assertRaises(ValueError): m.debug.configure(**options)
            self.assertEqual(m.debug.config(), {'enabled': True, 'breakpoints': [], 'traceLimit': 256})
        self.assertEqual(m.debug.memory('0x200008', 4)['bytes'], list(CODE))
        for at, length in [(0x40004404, 4), (0x2003ffff, 2), (0x210000, 1), (0x200000, 4097), (0x200000, 0)]:
            with self.subTest(at=at, length=length), self.assertRaises(ValueError): m.debug.memory(at, length)
        self.assertEqual(m.board.ticks, 0); self.assertIsNone(m.error)

    def test_fault_retains_trace_and_registers(self):
        m = Machine(image(bytes.fromhex('01480068fee700bf00000340')), debug={'enabled': True})
        r = m.run(10)
        self.assertIn('Unmodeled peripheral', r['error']); self.assertEqual(r['debug']['registers']['R0'], 0x40030000)
        self.assertEqual(r['debug']['trace'][-1]['pc'], 0x20000a)

    def test_breakpoint_suspends_irq_delivery_and_preserves_exception_return(self):
        data = bytearray(image(CODE)); struct.pack_into('<I', data, (16 + 55) * 4, 0x200401)
        data[0x400:0x402] = bytes.fromhex('7047')
        m = Machine(data, debug={'enabled': True, 'breakpoints': [0x200008]})
        m.irq.enabled = 1 << 55; m.board.pend(55)
        r = m.run(20)
        self.assertEqual(r['interrupts']['delivered'], 0); self.assertEqual(r['sp'], 0x20040000)
        m.debug.configure(breakpoints=[0x200400]); r = m.run(20)
        self.assertEqual(r['pc'], 0x200400); self.assertEqual(r['interrupts']['delivered'], 1)
        r = m.run(1)
        self.assertEqual(r['pc'], 0x200008); self.assertEqual(r['sp'], 0x20040000)
        self.assertEqual(r['interrupts']['active'], []); self.assertIsNone(r['error'])

    def test_workbench_reset_retains_configuration_but_clears_trace(self):
        w = Workbench(image(CODE), debug={'enabled': True, 'breakpoints': [0x200008]})
        try:
            w.machine.run(2); w.machine.run(1); w.reset('normal')
            self.assertFalse(w.running); self.assertTrue(w.machine.debug.enabled)
            self.assertEqual(w.machine.debug.breakpoints, {0x200008}); self.assertEqual(list(w.machine.debug.trace), [])
        finally: w.close()

    def test_workbench_run_stays_stopped_at_a_breakpoint(self):
        w = Workbench(image(CODE), debug={'enabled': True, 'breakpoints': [0x20000a]})
        try:
            with w.lock: w.running = True
            deadline = time.monotonic() + 2
            while w.running and time.monotonic() < deadline: time.sleep(.005)
            with w.lock:
                self.assertFalse(w.running); r = w.machine.report()
                self.assertEqual(r['debug']['stoppedAt'], 0x20000a)
                self.assertEqual(r['debug']['registers']['R0'], 1); self.assertEqual(r['board']['ticks'], 1)
        finally: w.close()

    def test_native_debug_api_supports_the_shared_workbench_controls(self):
        w = Workbench(image(CODE)); server = None
        try:
            server = make_server(w); thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
            connection = http.client.HTTPConnection('127.0.0.1', server.server_port)
            connection.request('GET', '/api/session'); token = json.loads(connection.getresponse().read())['token']
            def post(name, data):
                connection.request('POST', '/api/' + name, json.dumps(data), {'X-Session-Token': token, 'Content-Type': 'application/json'})
                response = connection.getresponse(); return response.status, json.loads(response.read())
            self.assertEqual(post('debug-memory', {'address': '0x200008', 'length': 4})[0], 400)
            code, state = post('debug', {'enabled': True, 'breakpoints': ['0x20000a']})
            self.assertEqual(code, 200); self.assertFalse(state['running']); self.assertTrue(state['report']['debug']['enabled'])
            code, state = post('step', {'instructions': 1}); self.assertEqual(state['report']['pc'], 0x20000a)
            code, memory = post('debug-memory', {'address': '0x200008', 'length': 4})
            self.assertEqual(code, 200); self.assertEqual(memory['bytes'], list(CODE))
            code, state = post('state', {}); self.assertEqual(state['report']['debug']['registers']['R0'], 1)
            code, state = post('reset', {'mode': 'normal'})
            self.assertFalse(state['running']); self.assertEqual(state['report']['debug']['breakpoints'], [0x20000a])
            self.assertEqual(post('debug', {'breakpoints': ['invalid']})[0], 400)
            code, state = post('debug', {'enabled': False}); self.assertEqual(state['report']['debug'], {'enabled': False})
            connection.close()
        finally:
            if server: server.shutdown(); server.server_close()
            w.close()

    def test_cli_debug_report_and_opt_in_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'probe.bin'; path.write_bytes(image(CODE))
            result = subprocess.run([sys.executable, '-m', 'sq64_emulator', str(path), '--headless', '--debug', '--breakpoint', '0x20000a', '--inspect', '0x200008:4'], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(result.stdout)
            self.assertEqual(report['status'], 'breakpoint'); self.assertEqual(report['debug']['registers']['R0'], 1)
            self.assertEqual(report['debug']['memory'][0]['bytes'], list(CODE))
            result = subprocess.run([sys.executable, '-m', 'sq64_emulator', str(path), '--headless', '--breakpoint', '0x200008'], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2); self.assertIn('require --debug', result.stderr)
