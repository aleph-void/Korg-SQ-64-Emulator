"""Opt-in CPU inspection without peripheral reads or unbounded tracing."""
from collections import deque
from unicorn import arm_const as arm

REGISTERS = [f'R{i}' for i in range(13)] + ['SP', 'LR', 'PC', 'XPSR', 'MSP', 'PSP', 'CONTROL', 'PRIMASK', 'BASEPRI', 'FAULTMASK']
CODE_REGIONS = [(0, 0x4000), (0x200000, 0x10000), (0x8000000, 0x10000), (0x20000000, 0x40000)]

def address(value):
    if isinstance(value, str):
        try: value = int(value, 16 if value.lower().startswith('0x') else 10)
        except ValueError: raise ValueError('Enter a 32-bit address (decimal or 0x hexadecimal)') from None
    if type(value) is not int or not 0 <= value <= 0xffffffff:
        raise ValueError('Enter a 32-bit address (decimal or 0x hexadecimal)')
    return value

def memory_range(at, length):
    at = address(at)
    if type(length) is not int or not 1 <= length <= 4096: raise ValueError('Memory length must be 1..4096')
    if not any(base <= at and at + length <= base + size for base, size in CODE_REGIONS):
        raise ValueError('Inspection supports mapped code and RAM only; use the execution report for peripherals')
    return at

class Debugger:
    def __init__(self, machine):
        self.machine = machine; self.enabled = False; self.breakpoints = set()
        self.trace_limit = 256; self.trace = deque(maxlen=self.trace_limit)
        self.stopped_at = None; self.skip = None

    def configure(self, *, enabled=None, breakpoints=None, traceLimit=None):
        if enabled is None: enabled = self.enabled
        if type(enabled) is not bool: raise ValueError('Debug enabled must be a boolean')
        if breakpoints is None: breakpoints = list(self.breakpoints)
        if not isinstance(breakpoints, list) or len(breakpoints) > 64: raise ValueError('Use at most 64 breakpoints')
        points = {memory_range(address(value) & ~1, 2) for value in breakpoints}
        limit = self.trace_limit if traceLimit is None else traceLimit
        if type(limit) is not int or not 0 <= limit <= 4096: raise ValueError('Trace limit must be 0..4096')
        self.enabled = enabled; self.breakpoints = points; self.trace_limit = limit
        self.trace = deque(self.trace if enabled else [], maxlen=limit)
        if not enabled: self.stopped_at = self.skip = None

    def config(self):
        return {'enabled': self.enabled, 'breakpoints': sorted(self.breakpoints), 'traceLimit': self.trace_limit}

    def begin_run(self):
        self.skip = self.stopped_at if self.stopped_at == self.machine.uc.reg_read(arm.UC_ARM_REG_PC) else None
        self.stopped_at = None

    def instruction(self, pc, size):
        skip = self.skip == pc; self.skip = None
        if not skip and pc in self.breakpoints:
            self.stopped_at = pc; self.machine.uc.emu_stop(); return True
        if self.trace_limit:
            self.trace.append({'tick': self.machine.board.ticks, 'pc': pc, 'bytes': list(self.machine.uc.mem_read(pc, size))})
        return False

    def memory(self, at, length=128):
        if not self.enabled: raise ValueError('Enable debugging first')
        at = memory_range(at, length)
        return {'address': at, 'bytes': list(self.machine.uc.mem_read(at, length))}

    def report(self):
        if not self.enabled: return {'enabled': False}
        return {**self.config(), 'stoppedAt': self.stopped_at,
                'registers': {r: self.machine.uc.reg_read(getattr(arm, 'UC_ARM_REG_' + r)) for r in REGISTERS},
                'trace': list(self.trace)}
