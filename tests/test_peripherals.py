import unittest
from sq64_emulator.flash import SpiFlash
from sq64_emulator.panel import Panel
from sq64_emulator.core import Machine
from helpers import image

class FlashTests(unittest.TestCase):
    def setUp(self): self.flash = SpiFlash()
    def transaction(self, data):
        self.flash.select(True)
        try: return bytes(self.flash.exchange(v) for v in data)
        finally: self.flash.select(False)

    def test_jedec_and_read(self):
        self.assertEqual(self.transaction([0x9f, 0, 0, 0])[1:], bytes.fromhex('ef4014'))
        self.assertEqual(self.transaction([3, 0, 0, 0, 0])[-1], 255)

    def test_write_enable_required(self):
        with self.assertRaises(ValueError): self.transaction([2, 0, 0, 0, 42])
        with self.assertRaises(ValueError): self.transaction([0x20, 0, 0, 0])

    def test_program_clears_bits_page_wrap_and_erase(self):
        self.transaction([6]); self.transaction([2, 0, 0, 255, 0x55, 0xaa])
        self.assertEqual(self.flash.data[255], 0x55); self.assertEqual(self.flash.data[0], 0xaa)
        self.assertFalse(self.flash.enabled)
        self.transaction([6]); self.transaction([2, 0, 0, 255, 0xff]); self.assertEqual(self.flash.data[255], 0x55)
        self.transaction([6]); self.transaction([0x20, 0, 0, 0]); self.assertEqual(self.flash.data[:4096], bytes([255]) * 4096)

    def test_fast_read_dummy_and_deselected_error(self):
        self.flash.data[0] = 42
        self.assertEqual(self.transaction([11, 0, 0, 0, 0, 0])[-2:], bytes([255, 42]))
        with self.assertRaises(ValueError): self.flash.exchange(0)

class PanelTests(unittest.TestCase):
    def test_controls_and_explicit_wiring(self):
        panel = Panel({'global': [5, 3]})
        self.assertEqual(len(panel.buttons), 85); self.assertEqual(len(panel.encoders), 6)
        panel.event({'type': 'button', 'control': 'global', 'down': True}, 0)
        self.assertEqual(panel.rx[5], 247)
        panel.event({'type': 'encoder', 'control': 'tempo', 'delta': -1}, 1)
        self.assertEqual(panel.encoders['tempo'], -1)
        self.assertFalse(panel.snapshot()['wiringVerified'])

    def test_bad_wiring_and_events(self):
        with self.assertRaises(ValueError): Panel({'global': [50, 3]})
        with self.assertRaises(ValueError): Panel().event({'type': 'encoder', 'control': 'tempo', 'delta': True}, 0)
        with self.assertRaises(ValueError): Panel().frame(bytes(10))

    def test_circular_dma_transfers_actual_scan_bytes_and_pends_irq(self):
        machine = Machine(image()); board = machine.board
        tx, rx = 0x40026458, 0x40026440
        for base, control, memory in [(tx, 0x559, 0x20000100), (rx, 0x519, 0x20000200)]:
            board.put(base, control); board.put(base + 4, 128); board.put(base + 8, 0x4001300c); board.put(base + 12, memory)
        board.ticks = 512; board.complete_dma()
        self.assertEqual(board.get(tx + 4), 64); self.assertTrue(machine.irq.pending & 1 << 59)
        self.assertEqual(bytes(machine.uc.mem_read(0x20000200, 64)), bytes([255]) * 64)
        board.ticks = 1024; board.complete_dma(); self.assertEqual(board.get(tx + 4), 128)
