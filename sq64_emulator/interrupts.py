# Host-side exception model developed for this project, not firmware code.
"""Bounded Cortex-M exception delivery using the image's live VTOR/NVIC state.

Implements integer handlers, MSP/PSP, priority masking and nested
external IRQs. Events are scheduled at explicit firmware instruction boundaries,
not simulated wall-clock times. Preserves eager FP frames or the firmware's lazy
FP reservation and first-use lazy preservation inside handlers. IT preemption
requires instruction hooks that expose the live EPSR and honor an immediate
exit; unmodified Unicorn 2.1.3 fails closed. Events use instruction boundaries.
Sources: https://documentation-service.arm.com/static/5f0352c0cafe527e86f5bc66
https://github.com/unicorn-engine/unicorn/blob/2.1.3/docs/FAQ.md
"""
from collections import deque
import struct

from unicorn import UC_HOOK_CODE, UC_HOOK_INTR, UC_HOOK_BLOCK
from unicorn import arm_const as arm
from capstone import Cs, CS_ARCH_ARM, CS_MODE_THUMB, CS_MODE_MCLASS


class CortexInterrupts:
    BANK_BYTES = 12  # model supports external IRQs 0..95
    FRAME_REGS = (arm.UC_ARM_REG_R0, arm.UC_ARM_REG_R1, arm.UC_ARM_REG_R2,
                  arm.UC_ARM_REG_R3, arm.UC_ARM_REG_R12, arm.UC_ARM_REG_LR)

    def __init__(self, uc, spec, fail):
        self.uc, self.spec = uc, spec
        self.failed = False
        def failure(message):
            self.failed = True
            fail(message)
        self.fail = failure
        self.enabled = int.from_bytes(uc.mem_read(0xe000e100, self.BANK_BYTES), 'little')
        self.pending = int.from_bytes(uc.mem_read(0xe000e200, self.BANK_BYTES), 'little')
        self.active, self.queue, self.trace, self.frames = [], deque(), [], []
        self.delivered = 0
        self.scheduled = 0
        self.instructions = 0
        self.suppressed = set()
        self.events = {}
        self.visits = {}
        self.decoder = Cs(CS_ARCH_ARM, CS_MODE_THUMB | CS_MODE_MCLASS)
        self.fp_instructions = {}
        self.blocks = set()
        self.it_instructions = {}
        for event in spec.get('events', []):
            irq = event['irq']
            if not 0 <= irq < self.BANK_BYTES * 8 or event.get('count', 1) < 1:
                raise ValueError('Unsupported IRQ event')
            self.events.setdefault(event['at'] & ~1, []).append(event)
        uc.hook_add(UC_HOOK_BLOCK, self.on_block)
        uc.hook_add(UC_HOOK_CODE, self.on_code)
        uc.hook_add(UC_HOOK_INTR, self.on_exception)

    def run(self, entry, until, count):
        """Execute with the controller's independent total instruction budget."""
        self.uc.emu_start(entry, until, count=count)

    @staticmethod
    def word(uc, address):
        return int.from_bytes(uc.mem_read(address, 4), 'little')

    def on_block(self, uc, address, size, user):
        if (address, size) in self.blocks:
            return
        self.blocks.add((address, size))
        # Decode at real instruction boundaries. A translated block can end
        # inside an IT block, so inspect its remaining (at most four) slots.
        for insn in self.decoder.disasm(bytes(uc.mem_read(address, size)), address):
            if insn.mnemonic.startswith('it') and set(insn.mnemonic[1:]) <= {'t', 'e'}:
                start = insn.address + insn.size
                following = self.decoder.disasm(bytes(uc.mem_read(start, 16)), start,
                                                 count=len(insn.mnemonic) - 1)
                state = insn.bytes[0]
                for slot in following:
                    self.it_instructions[slot.address] = state
                    state = 0 if state & 7 == 0 else (state & 0xe0) | ((state << 1) & 0x1f)

    def write(self, address, size, value):
        for base, field, clear in ((0xe000e100, 'enabled', False), (0xe000e180, 'enabled', True),
                                   (0xe000e200, 'pending', False), (0xe000e280, 'pending', True)):
            if base <= address and address + size <= base + self.BANK_BYTES:
                bits = value << (8 * (address - base))
                current = getattr(self, field)
                setattr(self, field, current & ~bits if clear else current | bits)
                return
        if address == 0xe000ef00:
            if size != 4 or not 0 <= value < self.BANK_BYTES * 8:
                raise ValueError('Unsupported STIR write')
            self.pending |= 1 << value

    def read(self, address, size):
        active = sum(1 << frame['irq'] for frame in self.active)
        for base, value in ((0xe000e100, self.enabled), (0xe000e180, self.enabled),
                            (0xe000e200, self.pending), (0xe000e280, self.pending),
                            (0xe000e300, active)):
            if base <= address and address + size <= base + self.BANK_BYTES:
                result = (value >> (8 * (address - base))) & ((1 << (size * 8)) - 1)
                self.uc.mem_write(address, result.to_bytes(size, 'little'))
                return

    def priority(self, irq):
        # This STM32 profile implements four priority bits.
        return self.uc.mem_read(0xe000e400 + irq, 1)[0] & 0xf0

    def eligible(self):
        uc = self.uc
        if uc.reg_read(arm.UC_ARM_REG_PRIMASK) or uc.reg_read(arm.UC_ARM_REG_FAULTMASK):
            return None
        if self.word(uc, 0xe000ed0c) & 0x700:
            raise ValueError('Priority grouping is outside this interrupt fixture')
        ceiling = self.priority(self.active[-1]['irq']) if self.active else 256
        basepri = uc.reg_read(arm.UC_ARM_REG_BASEPRI) & 0xf0
        if basepri:
            ceiling = min(ceiling, basepri)
        available = self.pending & self.enabled
        choices = [(self.priority(irq), irq) for irq in range(self.BANK_BYTES * 8)
                   if available & (1 << irq) and self.priority(irq) < ceiling]
        return min(choices)[1] if choices else None

    def request_event(self, event):
        irq = event['irq']
        timer = event.get('timer')
        if timer is not None:
            if (timer, irq) not in ((0x40001000, 54), (0x40001400, 55)):
                raise ValueError('Unverified timer/IRQ pair')
            if not (self.word(self.uc, timer) & self.word(self.uc, timer + 0xc) & 1):
                return
            self.uc.mem_write(timer + 0x10, (self.word(self.uc, timer + 0x10) | 1).to_bytes(4, 'little'))
        self.pending |= 1 << irq
        self.scheduled += 1

    def enter(self, irq, pc):
        uc = self.uc
        control, xpsr = uc.reg_read(arm.UC_ARM_REG_CONTROL), uc.reg_read(arm.UC_ARM_REG_XPSR)
        if pc in self.it_instructions:
            state = self.it_instructions[pc]
            actual = ((xpsr >> 25) & 3) | ((xpsr >> 8) & 0xfc)
            if actual != state:
                raise ValueError('IT-block interrupt delivery requires the validated IT-state engine')
        extended = bool(control & 4)
        fpccr = self.word(uc, 0xe000ef34)
        lazy = extended and bool(fpccr & (1 << 30))
        if extended and not fpccr & (1 << 31):
            raise ValueError('FP context without automatic preservation is outside this fixture')
        if (xpsr & 0x1ff) != (self.active[-1]['irq'] + 16 if self.active else 0):
            raise ValueError('Unexpected exception context')
        handler = self.word(uc, self.word(uc, 0xe000ed08) + (irq + 16) * 4)
        if not handler & 1:
            raise ValueError('IRQ vector is not a Thumb entry')
        use_psp = not self.active and bool(control & 2)
        bank = arm.UC_ARM_REG_PSP if use_psp else arm.UC_ARM_REG_MSP
        sp = uc.reg_read(bank)
        padding = bool(self.word(uc, 0xe000ed14) & 0x200 and sp & 4)
        frame_size = 104 if extended else 32
        frame_sp = sp - frame_size - (4 if padding else 0)
        if sp & 3:
            raise ValueError('Unaligned exception stack')
        values = [uc.reg_read(reg) for reg in self.FRAME_REGS]
        stacked_xpsr = (xpsr & ~0x200) | (0x200 if padding else 0)
        uc.mem_write(frame_sp, struct.pack('<8I', *values, pc, stacked_xpsr))
        exc_return = 0xfffffffd if use_psp else (0xfffffff1 if self.active else 0xfffffff9)
        if extended:
            exc_return &= ~0x10
            if lazy:
                uc.mem_write(0xe000ef34, (fpccr | 1).to_bytes(4, 'little'))
                uc.mem_write(0xe000ef38, (frame_sp + 32).to_bytes(4, 'little'))
            else:
                fp = [uc.reg_read(arm.UC_ARM_REG_S0 + i) for i in range(16)]
                uc.mem_write(frame_sp + 32, struct.pack('<17I', *fp, uc.reg_read(arm.UC_ARM_REG_FPSCR)))
        frame = {'irq': irq, 'sp': frame_sp, 'bank': bank, 'exc_return': exc_return,
                 'size': frame_size, 'control': control, 'extended': extended,
                 'lazy': lazy, 'fp_saved': extended and not lazy, 'fpccr': fpccr}
        self.active.append(frame)
        self.pending &= ~(1 << irq)
        uc.reg_write(bank, frame_sp)
        # Writing PC asks Unicorn to leave its translated block and restore
        # JIT state. Do it before replacing EPSR, otherwise that restoration
        # can reinstate the interrupted IT condition in the handler.
        uc.reg_write(arm.UC_ARM_REG_PC, handler)
        # IT/ICI state belongs to the interrupted code, not its handler.
        uc.reg_write(arm.UC_ARM_REG_XPSR_NZCVQG, (xpsr & ~0x0600ffff) | 0x01000000 | (irq + 16))
        uc.reg_write(arm.UC_ARM_REG_CONTROL, control & ~4)
        uc.reg_write(arm.UC_ARM_REG_LR, exc_return)
        self.delivered += 1
        self.trace.append(('enter', irq, len(self.active)))
        if len(self.frames) < 16:
            self.frames.append({'irq': irq, 'vector': hex(handler), 'frame_sp': hex(frame_sp),
                                'interrupted_pc': hex(pc), 'stacked_xpsr': hex(stacked_xpsr),
                                'extended': extended, 'lazy': lazy})
        if self.delivered > self.spec.get('max_deliveries', 20000):
            raise ValueError('Interrupt delivery budget exceeded')

    def on_code(self, uc, address, size, user):
        if self.failed:
            uc.emu_stop()
            return
        try:
            self.instructions += 1
            if self.instructions > self.spec.get('instruction_limit', 24000000):
                self.fail('interrupt_instruction_limit')
                return
            if address not in self.suppressed:
                for event in self.events.get(address, []):
                    if self.active and not event.get('in_handler'):
                        continue
                    key = id(event)
                    self.visits[key] = self.visits.get(key, 0) + 1
                    if 'visit' not in event or self.visits[key] == event['visit']:
                        if self.active:
                            self.queue.extendleft([event] * event.get('count', 1))
                        else:
                            self.queue.extend([event] * event.get('count', 1))
                        self.suppressed.add(address)
            if self.queue and not self.active and not self.pending:
                self.request_event(self.queue.popleft())
            # Nested fixtures may explicitly pend a higher-priority IRQ in a
            # handler. Same/lower-priority pending IRQs wait until return.
            if self.queue and self.active and self.queue[0].get('in_handler'):
                self.request_event(self.queue.popleft())
            irq = self.eligible() if self.pending else None
            if irq is not None:
                self.enter(irq, address)
            else:
                self.suppressed.discard(address)
                if self.active:
                    if address not in self.fp_instructions:
                        insn = next(self.decoder.disasm(bytes(uc.mem_read(address, size)), address), None)
                        if insn is None:
                            raise ValueError('Cannot decode handler instruction')
                        self.fp_instructions[address] = insn.mnemonic.startswith('v')
                    if self.fp_instructions[address]:
                        # The first handler FP instruction completes any
                        # outstanding lazy save before modifying FP state.
                        for frame in reversed(self.active):
                            if frame['lazy'] and not frame['fp_saved']:
                                fp = [uc.reg_read(arm.UC_ARM_REG_S0 + i) for i in range(16)]
                                uc.mem_write(frame['sp'] + 32, struct.pack('<17I', *fp,
                                             uc.reg_read(arm.UC_ARM_REG_FPSCR)))
                                frame['fp_saved'] = True
                                self.trace.append(('lazy_fp_save', frame['irq'], len(self.active)))
                        fpccr = self.word(uc, 0xe000ef34)
                        uc.mem_write(0xe000ef34, (fpccr & ~1).to_bytes(4, 'little'))
                        if fpccr & (1 << 31):
                            uc.reg_write(arm.UC_ARM_REG_CONTROL, uc.reg_read(arm.UC_ARM_REG_CONTROL) | 4)
        except ValueError as exc:
            self.fail('interrupt_model: ' + str(exc))

    def on_exception(self, uc, number, user):
        try:
            if number != 8 or not self.active:
                raise ValueError('Unhandled CPU exception %d' % number)
            current = self.active[-1]
            token = uc.reg_read(arm.UC_ARM_REG_PC) | 1
            if token != current['exc_return'] or uc.reg_read(current['bank']) != current['sp']:
                raise ValueError('Invalid EXC_RETURN or unbalanced handler stack')
            values = struct.unpack('<8I', uc.mem_read(current['sp'], 32))
            xpsr = values[7]
            expected_ipsr = self.active[-2]['irq'] + 16 if len(self.active) > 1 else 0
            if not xpsr & 0x01000000 or xpsr & 0x1ff != expected_ipsr:
                raise ValueError('Invalid stacked exception state')
            for reg, value in zip(self.FRAME_REGS, values):
                uc.reg_write(reg, value)
            if current['extended']:
                if current['lazy'] and not current['fp_saved']:
                    if not self.word(uc, 0xe000ef34) & 1:
                        raise ValueError('Unexpected lazy FP preservation state')
                else:
                    fp = struct.unpack('<17I', uc.mem_read(current['sp'] + 32, 68))
                    for i, value in enumerate(fp[:16]):
                        uc.reg_write(arm.UC_ARM_REG_S0 + i, value)
                    uc.reg_write(arm.UC_ARM_REG_FPSCR, fp[16])
                uc.mem_write(0xe000ef34, current['fpccr'].to_bytes(4, 'little'))
            uc.reg_write(current['bank'], current['sp'] + current['size'] + (4 if xpsr & 0x200 else 0))
            self.active.pop()
            uc.reg_write(arm.UC_ARM_REG_PC, values[6] | 1)
            # Unicorn's plain XPSR setter omits GE[3:0]. Exception return
            # restores those packed-arithmetic flags along with NZCVQ/IT/IPSR.
            uc.reg_write(arm.UC_ARM_REG_XPSR_NZCVQG, xpsr & ~0x200)
            uc.reg_write(arm.UC_ARM_REG_CONTROL, current['control'])
            self.trace.append(('return', current['irq'], len(self.active)))
        except ValueError as exc:
            self.fail('interrupt_model: ' + str(exc))

    def result(self):
        return {'scheduled': self.scheduled, 'delivered': self.delivered,
                'instructions': self.instructions,
                'enabled': hex(self.enabled), 'pending': hex(self.pending),
                'active': [f['irq'] for f in self.active], 'queued': len(self.queue),
                'trace': self.trace, 'sample_frames': self.frames,
                'scope': 'Architectural exception model; virtual instruction time, not cycle timing'}
