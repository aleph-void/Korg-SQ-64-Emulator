import hashlib
import struct
import unittest
from sq64_emulator.core import Machine
from sq64_emulator.image import Image, FLASH
from helpers import image

class CoreTests(unittest.TestCase):
    def test_reset_executes_thumb_and_binds_report(self):
        content = image(); machine = Machine(content); report = machine.run(21)
        self.assertIsNone(report['error']); self.assertEqual(report['board']['ticks'], 21)
        self.assertEqual(report['imageSha256'], hashlib.sha256(content).hexdigest())
        self.assertEqual(report['hardwareConformance'], 'not-established')

    def test_vector_validation(self):
        for stack, reset in [(0x20000000, 0x200009), (0x20040004, 0x200009), (0x20040000, 0x200008), (0x20040000, 0x210001)]:
            with self.subTest(stack=stack, reset=reset):
                data = bytearray(image()); struct.pack_into('<II', data, 0, stack, reset)
                with self.assertRaises(ValueError): Image.load(data)

    def test_payload_maps_to_storage_without_preloading_application(self):
        data = image() + bytes([0x11]) * 0x4000 + bytes([0x22]) * 0x20000 + bytes([0x33]) * 0x4000
        loaded = Image.load(data)
        self.assertEqual(len(loaded.segments), 1)
        self.assertEqual(loaded.spi[0:4], b'\x11' * 4)
        self.assertEqual(loaded.spi[0x4000:0x4004], b'\x33' * 4)
        self.assertEqual(loaded.spi[0x10000:0x10004], b'\x22' * 4)

    def test_unaligned_multiword_faults_but_scalar_is_supported(self):
        for opcode, fault in [('02c8', True), ('0168', False)]:
            code = bytes.fromhex('0148' + opcode + 'fee700bf') + struct.pack('<I', 0x20000001)
            machine = Machine(image(code)); result = machine.run(10)
            self.assertEqual(bool(result['error']), fault)
            if fault: self.assertIn('alignment', result['error'])

    def test_exception_entry_return_and_stack_restoration(self):
        content = bytearray(image()); struct.pack_into('<I', content, (16 + 55) * 4, FLASH + 0x401)
        content[0x400:0x402] = bytes.fromhex('7047')
        machine = Machine(content); machine.irq.enabled = 1 << 55; machine.board.pend(55)
        report = machine.run(20)
        self.assertIsNone(report['error']); self.assertEqual(report['interrupts']['delivered'], 1)
        self.assertEqual(report['interrupts']['active'], []); self.assertEqual(report['sp'], 0x20040000)

    def test_replay_is_deterministic(self):
        events = [{'tick': 2, 'type': 'button', 'control': 'global', 'down': True},
                  {'tick': 4, 'type': 'button', 'control': 'global', 'down': False}]
        states = []
        for _ in range(2):
            machine = Machine(image(), panel_mapping={'global': [2, 3]}); machine.replay(events); machine.run(6)
            states.append(machine.board.panel.snapshot())
            self.assertEqual(machine.board.panel.events, events)
        self.assertEqual(states[0], states[1])

    def test_replay_rejects_backward_time(self):
        machine = Machine(image()); machine.run(3)
        with self.assertRaises(ValueError): machine.replay([{'tick': 2}])

    def test_unknown_peripherals_fail_closed(self):
        code = bytes.fromhex('01480068fee700bf') + struct.pack('<I', 0x40030000)
        result = Machine(image(code)).run(10)
        self.assertIn('Unmodeled peripheral read', result['error'])

    def test_display_dma_and_timer_candidate(self):
        import shutil, subprocess, tempfile
        from pathlib import Path
        if not shutil.which('arm-none-eabi-gcc'): self.skipTest('ARM GNU toolchain required for C integration probe')
        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'probe.elf'
            subprocess.run(['arm-none-eabi-gcc', '-mcpu=cortex-m7', '-mthumb', '-Os', '-nostdlib', '-ffreestanding', '-Wl,--build-id=none', '-T', str(root / 'examples/probe.ld'), str(root / 'examples/panel_probe.c'), '-o', str(output)], check=True)
            result = Machine(output.read_bytes()).run(70000)
            self.assertIsNone(result['error']); self.assertGreater(result['interrupts']['delivered'], 0)
            self.assertTrue(any(row[0] == 'display-frame' for row in result['board']['trace']))
