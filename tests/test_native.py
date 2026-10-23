"""Actual QEMU CPU, native critical guards, virtual time and ownership."""
import struct
import tempfile
import unittest
from pathlib import Path
from helpers import image
from sq64_emulator.native import NativeMachine

class NativeTests(unittest.TestCase):
    def test_reset_thumb_and_exact_tick_budget(self):
        with NativeMachine(image()) as m:
            self.assertEqual(m.register(15),0x200008)
            self.assertEqual(m.register(13),0x20040000)
            before=m.state()['virtualTimeNs'];state=m.run(21)
            self.assertFalse(state['faulted'],state)
            self.assertEqual(state['virtualTimeNs']-before,21)
            self.assertEqual(state['pc'],0x200008)

    def test_cpu_store_and_native_ram_debugger(self):
        code=bytes.fromhex('01485a210160fee7')+struct.pack('<I',0x20001234)
        with NativeMachine(image(code)) as m:
            self.assertFalse(m.run(20)['faulted'])
            self.assertEqual(m.read(0x20001234,4),b'\x5a\0\0\0')
            m.write_ram(0x20001234,b'\xaa\xbb');self.assertEqual(m.read(0x20001234,2),b'\xaa\xbb')
            with self.assertRaises(ValueError):m.write_ram(0x200008,b'\0\0')

    def test_cpu_internal_flash_hazard_stops_before_mutation(self):
        for address in (0x200100,0x8000100,0x40023c10,0x1ff00000,0x40023c08):
            with self.subTest(address=hex(address)):
                code=bytes.fromhex('014806210160fee7')+struct.pack('<I',address)
                with NativeMachine(image(code)) as m:
                    before=m.read(0x200000,65536);state=m.run(20)
                    self.assertTrue(state['faulted'],state)
                    self.assertEqual(state['fault']['address'],address)
                    self.assertTrue(m.critical_report(state)['terminated'])
                    self.assertEqual(m.read(0x200000,65536),before)
                    with self.assertRaises(Exception):m.run(1)

    def test_unmodeled_mmio_and_writer_exclusion(self):
        code=bytes.fromhex('01480068fee700bf')+struct.pack('<I',0x40030000)
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'spi.bin'
            with NativeMachine(image(code),flash_path=path) as m:
                process=m.process.process
                with self.assertRaises(BlockingIOError):NativeMachine(image(),flash_path=path)
                self.assertEqual(m.run(10)['fault']['operation'],'unmodeled-peripheral-read')
            self.assertIsNotNone(process.poll())
            self.assertEqual(path.stat().st_size,0x1000000)
            with NativeMachine(image(),flash_path=path) as m:self.assertFalse(m.run(1)['faulted'])
            path.write_bytes(b'bad')
            with self.assertRaises(ValueError):NativeMachine(image(),flash_path=path)
            self.assertEqual(path.read_bytes(),b'bad')
