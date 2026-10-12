import unittest
from sq64_emulator.server import Workbench
from sq64_emulator.image import Image
from sq64_emulator.core import Machine
from helpers import image

class WorkbenchTests(unittest.TestCase):
    def setUp(self): self.workbench = Workbench(image())
    def tearDown(self): self.workbench.close()

    def test_power_chords_are_held_at_reset_and_releasable(self):
        work = self.workbench
        work.reset('version'); panel = work.machine.board.panel
        self.assertTrue(panel.buttons['global']); self.assertFalse(panel.buttons['pattern'])
        work.reset('update'); panel = work.machine.board.panel
        self.assertTrue(panel.buttons['global']); self.assertTrue(panel.buttons['pattern'])
        work.machine.event({'type': 'button', 'control': 'global', 'down': False})
        self.assertFalse(panel.buttons['global'])
        work.reset('normal'); self.assertFalse(any(work.machine.board.panel.buttons.values()))

    def test_reset_preserves_flash_and_initial_ram_segments(self):
        loaded = Image.load(image()); loaded.segments.append((0x20000000, b'original test bytes'))
        work = self.workbench; work.machine = Machine(loaded)
        work.machine.board.flash.data[0x1234] = 42
        work.machine.uc.mem_write(0x20000000, b'changed!')
        work.reset('normal')
        self.assertEqual(work.machine.board.flash.data[0x1234], 42)
        self.assertEqual(bytes(work.machine.uc.mem_read(0x20000000, 19)), b'original test bytes')

    def test_invalid_mode_does_not_replace_the_machine(self):
        old = self.workbench.machine
        with self.assertRaises(ValueError): self.workbench.reset('invalid')
        self.assertIs(old, self.workbench.machine)

if __name__ == '__main__': unittest.main()
