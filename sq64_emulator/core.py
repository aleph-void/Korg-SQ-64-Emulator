"""Reset-driven ARM execution with no stock function substitutions."""
import struct
from collections import deque
import unicorn
from unicorn import arm_const as arm
from capstone import Cs, CS_ARCH_ARM, CS_MODE_THUMB, CS_MODE_MCLASS, arm_const as csarm
from .image import Image, FLASH
from .board import Board
from .interrupts import CortexInterrupts
from .debug import Debugger

class Machine:
    def __init__(self, image, *, panel_mapping=None, cycles_per_instruction=64, debug=None):
        if unicorn.__version__ != '2.1.3': raise ValueError('Execution requires Unicorn 2.1.3')
        self.image = image if isinstance(image, Image) else Image.load(image)
        self.uc = unicorn.Uc(unicorn.UC_ARCH_ARM, unicorn.UC_MODE_THUMB | unicorn.UC_MODE_MCLASS)
        self.uc.ctl_set_cpu_model(arm.UC_CPU_ARM_CORTEX_M7)
        for address, size in [(0, 0x4000), (FLASH, 0x10000), (0x08000000, 0x10000), (0x20000000, 0x40000), (0x40000000, 0x80000), (0x50000000, 0x40000), (0xe000e000, 0x2000)]: self.uc.mem_map(address, size)
        for address, data in self.image.segments:
            self.uc.mem_write(address, data)
            if FLASH <= address < FLASH + 0x10000: self.uc.mem_write(address + 0x07e00000, data)
        stack, reset = struct.unpack('<2I', self.uc.mem_read(self.image.vector, 8))
        self.uc.reg_write(arm.UC_ARM_REG_MSP, stack); self.uc.reg_write(arm.UC_ARM_REG_PC, reset)
        self.uc.reg_write(arm.UC_ARM_REG_XPSR, 0x01000000)
        self.uc.mem_write(0xe000ed08, self.image.vector.to_bytes(4, 'little'))
        self.error = None; self.breakpoints = set(); self.breakpoint = None; self.events = []; self.event_index = 0
        self.debug = Debugger(self)
        if debug is not None: self.debug.configure(**debug)
        self.decoder = Cs(CS_ARCH_ARM, CS_MODE_THUMB | CS_MODE_MCLASS); self.decode_cache = {}
        self.board = Board(self.uc, self.image, panel_mapping=panel_mapping, cycles_per_instruction=cycles_per_instruction)
        self.uc.hook_add(unicorn.UC_HOOK_CODE, self.instruction)
        self.irq = CortexInterrupts(self.uc, {'instruction_limit': 10**12, 'max_deliveries': 10**9}, self.fail)
        self.irq.trace = deque(maxlen=2048); self.board.irq = self.irq
        self.uc.hook_add(unicorn.UC_HOOK_MEM_READ, self.read)
        self.uc.hook_add(unicorn.UC_HOOK_MEM_WRITE, self.write)

    def fail(self, message): self.error = str(message); self.uc.emu_stop()

    def instruction(self, uc, address, size, user):
        if self.error: uc.emu_stop(); return
        if address in self.breakpoints: self.breakpoint = address; uc.emu_stop(); return
        try:
            if self.debug.enabled and self.debug.instruction(address, size): return
            self.board.advance()
            while self.event_index < len(self.events) and self.events[self.event_index]['tick'] <= self.board.ticks:
                self.event(self.events[self.event_index]); self.event_index += 1
        except (ValueError, unicorn.UcError) as error: self.fail(error)

    def alignment(self, address, size):
        if size <= 1 or address % min(size, 4) == 0: return
        pc = self.uc.reg_read(arm.UC_ARM_REG_PC)
        code = bytes(self.uc.mem_read(pc, 4)); key = pc, code
        if key not in self.decode_cache: self.decode_cache[key] = next(self.decoder.disasm(code, pc, count=1), None)
        insn = self.decode_cache[key]
        allowed = {getattr(csarm, 'ARM_INS_' + n) for n in ['LDR', 'LDRT', 'LDRH', 'LDRHT', 'LDRSH', 'LDRSHT', 'STR', 'STRT', 'STRH', 'STRHT']}
        if insn and insn.id in allowed and address < 0x40000000 and not self.board.get(0xe000ed14) & 8: return
        raise ValueError(f'Cortex-M alignment fault: PC=0x{pc:08x}, address=0x{address:08x}, width={size}')

    def read(self, uc, access, address, size, value, user):
        try:
            self.alignment(address, size)
            if address >= 0x40000000:
                self.board.read(address, size); self.irq.read(address, size)
        except (ValueError, unicorn.UcError) as error: self.fail(error)

    def write(self, uc, access, address, size, value, user):
        try:
            self.alignment(address, size)
            if FLASH <= address < FLASH + 0x10000: raise ValueError('Write to flash through execution alias')
            if address >= 0x40000000 or 0x08000000 <= address < 0x08010000:
                self.irq.write(address, size, value); self.board.write(address, size, value)
        except (ValueError, unicorn.UcError) as error: self.fail(error)

    def event(self, event):
        if event.get('type') == 'midi':
            data = event.get('data')
            if not isinstance(data, list) or not all(type(b) is int and 0 <= b <= 255 for b in data): raise ValueError('Invalid MIDI bytes')
            self.board.inject_midi(bytes(data), port=event.get('port', 'usb'))
        else: self.board.panel.event({k: v for k, v in event.items() if k != 'tick'}, self.board.ticks)

    def replay(self, events):
        if not isinstance(events, list) or len(events) > 100000: raise ValueError('Invalid replay')
        last = self.board.ticks
        for event in events:
            if type(event.get('tick')) is not int or event['tick'] < last: raise ValueError('Replay ticks must be ordered and in the future')
            last = event['tick']
        self.events = list(events); self.event_index = 0

    def run(self, instructions=10000):
        if type(instructions) is not int or not 1 <= instructions <= 10_000_000: raise ValueError('Instruction budget must be 1..10000000')
        self.breakpoint = None
        if self.debug.enabled: self.debug.begin_run()
        if not self.error:
            try: self.uc.emu_start(self.uc.reg_read(arm.UC_ARM_REG_PC) | 1, 0xffffffff, count=instructions)
            except unicorn.UcError as error: self.fail(error)
        return self.report()

    def report(self):
        irq = self.irq.result(); irq['trace'] = list(irq['trace'])
        return {'format': 'sq64-emulator-report', 'version': 1, 'imageSha256': self.image.sha256,
                'engine': f'unicorn-{unicorn.__version__}', 'status': 'fault' if self.error else 'breakpoint' if self.debug.stopped_at is not None or self.breakpoint is not None else 'paused',
                'error': self.error, 'pc': self.uc.reg_read(arm.UC_ARM_REG_PC), 'sp': self.uc.reg_read(arm.UC_ARM_REG_SP),
                'breakpoint': self.debug.stopped_at if self.debug.enabled else self.breakpoint, 'debug': self.debug.report(), 'board': self.board.report(), 'interrupts': irq,
                'hardwareConformance': 'not-established'}
