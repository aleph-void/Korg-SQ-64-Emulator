"""Bounded STM32 peripheral models, driven by virtual instruction time.

Modeled register semantics are intentionally separate from firmware state.
Register-only blocks are reported as approximations in every execution report.
"""
from collections import deque
import hashlib
from .flash import SpiFlash
from .panel import Panel
from .usb import UsbDevice

TIMERS = {0x40000000: 28, 0x40000400: 29, 0x40000800: 30, 0x40000c00: 50,
          0x40001000: 54, 0x40001400: 55, 0x40011400: 24}

class Board:
    def __init__(self, uc, image, *, panel_mapping=None, cycles_per_instruction=64, critical=None):
        self.critical = critical
        self.uc = uc; self.flash = SpiFlash(image.spi, critical=critical); self.panel = Panel(panel_mapping)
        self.cycles_per_instruction = cycles_per_instruction
        self.ticks = 0; self.cycles = 0; self.timer_fraction = {}; self.trace = deque(maxlen=4096)
        self.flash_rx = deque(); self.panel_rx = deque(); self.scan_position = 0
        self.uart_rx = {0x40004400: deque(), 0x40004800: deque()}
        self.midi_out = []; self.irq = None; self.last_panel_dma = 0; self.dma_reload = {}
        self.adc_sample = 0xc000; self.flash_key = 0; self.flash_control = 0x80000000
        self.approximations = {'instruction-time-clock', 'display-pixel-layout', 'panel-wiring', 'register-only-config-blocks', 'instantaneous-flash-completion'}
        self.accesses = set(); self.stopped = False
        self.usb = UsbDevice(self); self.midi_sequence = 0
        self.enabled_timers = set()
        self.approximations.add('usb-fs-transaction-time')

    def get(self, address, size=4): return int.from_bytes(self.uc.mem_read(address, size), 'little')
    def put(self, address, value, size=4): self.uc.mem_write(address, (value & ((1 << (size * 8)) - 1)).to_bytes(size, 'little'))
    def pend(self, irq):
        if self.irq:
            self.irq.pending |= 1 << irq; self.irq.scheduled += 1

    def advance(self):
        self.ticks += 1; self.cycles += self.cycles_per_instruction
        # Timer progression is independent of reading CNT or particular PCs.
        for base in tuple(self.enabled_timers):
            irq = TIMERS[base]
            if self.get(base) & 1:
                fraction = self.timer_fraction.get(base, 0) + self.cycles_per_instruction
                period = self.get(base + 0x28) + 1
                increment, self.timer_fraction[base] = divmod(fraction, period)
                if increment:
                    reload = self.get(base + 0x2c) + 1
                    if reload == 1: reload = 65536
                    count = self.get(base + 0x24) + increment
                    if count >= reload:
                        status = self.get(base + 0x10); self.put(base + 0x10, status | 1)
                        if self.get(base + 0xc) & 1 and not status & 1: self.pend(irq)
                    self.put(base + 0x24, count % reload)
        if self.ticks % 128 == 0:
            self.complete_dma(); self.usb.service()

    def inject_midi(self, data, port='usb'):
        if port == 'usb': self.usb.inject(data); return
        if port == 'din': port = 0x40004800
        if port not in self.uart_rx or len(data) > 4096: raise ValueError('Unsupported MIDI input')
        self.uart_rx[port].extend(data)
        if self.get(port + 0xc) & 0x20: self.pend(39 if port == 0x40004800 else 38)

    def emit_midi(self, value, port, cable=0):
        self.midi_sequence += 1
        self.midi_out.append({'sequence': self.midi_sequence, 'tick': self.ticks, 'port': port, 'cable': cable, 'byte': value & 255})
        if len(self.midi_out) > 8192: self.midi_out = self.midi_out[-4096:]

    def write(self, address, size, value):
        if self.critical:
            self.critical.memory(address, size, value)
            self.critical.dma_write(address, size, value, self.get)
        self.accesses.add(address)
        if address in TIMERS:
            if value & 1: self.enabled_timers.add(address)
            else: self.enabled_timers.discard(address)
        if 0x50000000 <= address < 0x50006000:
            if size != 4: raise ValueError('USB registers require word access')
            self.usb.write(address - 0x50000000, value); return
        if 0x08000000 <= address < 0x08010000:
            if size != 4 or address % 4 or self.flash_control & 0x80000000 or not self.flash_control & 1:
                raise ValueError('Invalid internal flash programming access')
            previous = self.get(address)
            if previous & value != value: raise ValueError('Internal flash attempted zero-to-one programming')
            self.put(address - 0x07e00000, value); return
        if address == 0x40023c04:
            if self.flash_key == 0x45670123 and value == 0xcdef89ab: self.flash_control &= ~0x80000000
            self.flash_key = value
        if address == 0x40023c10:
            self.flash_control = value
            if value & 0x10002 == 0x10002:
                sector = (value >> 3) & 15
                if sector >= 4 or value & 0x80000000: raise ValueError('Unsupported internal flash erase')
                for base in (0x00200000, 0x08000000): self.uc.mem_write(base + sector * 0x4000, bytes([255]) * 0x4000)
                self.flash_control &= ~0x10000
        for base in range(0x40020000, 0x40022400, 0x400):
            if address == base + 0x18:
                old = self.get(base + 0x14); self.put(base + 0x14, (old | (value & 65535)) & ~(value >> 16))
        if address == 0x40020418:
            if value & 0x02000000: self.flash.select(True)
            if value & 0x200: self.flash.select(False)
        if address == 0x4000380c:
            if size not in (1, 2): raise ValueError('Unsupported SPI word width')
            for b in value.to_bytes(size, 'big'): self.flash_rx.append(self.flash.exchange(b))
        if address == 0x4001300c:
            if size != 1: raise ValueError('Panel polled SPI requires byte transfers')
            self.panel_rx.append(self.panel.rx[self.scan_position % 48]); self.scan_position += 1
            self.panel.tx.append(value)
            if len(self.panel.tx) > 8192: del self.panel.tx[:4096]
        if address == 0x40003c0c:
            self.trace.append(('display-command-or-byte', value & 255))
        for base, queue in self.uart_rx.items():
            if address == base + 4:
                self.emit_midi(value, base)
        for controller in (0x40026000, 0x40026400):
            if address in (controller + 8, controller + 12): self.put(address - 8, self.get(address - 8) & ~value)
            for stream in range(8):
                base = controller + 0x10 + stream * 0x18
                if address == base + 4: self.dma_reload[base] = value
                if address == base and value & 1 and not self.get(base) & 1 and base in self.dma_reload:
                    self.put(base + 4, self.dma_reload[base])
        if address >= 0x40000000 and not self.known(address):
            raise ValueError(f'Unmodeled peripheral write at 0x{address:08x}')

    def known(self, address):
        windows = [(base, 0x80) for base in TIMERS] + [(0x40003800, 0x800), (0x40004400, 0x800),
            (0x40007000, 0x800), (0x40010000, 0x100), (0x40012000, 0x400), (0x40013000, 0x5000),
            (0x40020000, 0x2400), (0x40023800, 0x800), (0x40026000, 0x800), (0x50000000, 0x800),
            (0xe000e000, 0x2000)]
        return any(base <= address < base + length for base, length in windows)

    def read(self, address, size):
        self.accesses.add(address)
        if 0x50000000 <= address < 0x50006000:
            if size != 4: raise ValueError('USB registers require word access')
            self.put(address, self.usb.read(address - 0x50000000)); return
        if not self.known(address): raise ValueError(f'Unmodeled peripheral read at 0x{address:08x}')
        if address == 0x40023800:
            value = self.get(address)
            for bit in (0, 16, 24, 26):
                if value & 1 << bit: value |= 1 << (bit + 1)
            self.put(address, value)
        elif address == 0x40023808:
            value = self.get(address); self.put(address, value & ~12 | (value & 3) << 2)
        elif address == 0x40007004: self.put(address, self.get(address) | 0x4000)
        elif address == 0x40012000 and self.get(0x40012008) & 0x40000000:
            self.put(0x4001204c, self.adc_sample); self.put(0x40012008, self.get(0x40012008) & ~0x40000000); self.put(address, self.get(address) | 2)
        elif address == 0x40003808:
            self.complete_dma(); self.put(address, 2 | (0x200 if self.flash_rx else 0), size)
        elif address == 0x4000380c:
            if len(self.flash_rx) < size: raise ValueError('SPI receive FIFO underflow')
            self.put(address, int.from_bytes(bytes(self.flash_rx.popleft() for _ in range(size)), 'big'), size)
        elif address == 0x40013008: self.put(address, 2 | (0x200 if self.panel_rx else 0), size)
        elif address == 0x4001300c:
            if size != 1 or not self.panel_rx: raise ValueError('Panel FIFO underflow')
            self.put(address, self.panel_rx.popleft(), size)
        elif address == 0x40003c08: self.put(address, 2, size)
        elif address == 0x40013c14: self.put(address, self.get(address) | 4)
        elif address == 0x50000010: self.put(address, self.get(address) & ~0x31 | 0x80000000)
        elif address == 0x40023c0c: self.put(address, 0)
        elif address == 0x40023c10: self.put(address, self.flash_control)
        for base, queue in self.uart_rx.items():
            if address == base: self.put(address, 0xc0 | (0x20 if queue else 0), size)
            elif address == base + 4:
                if not queue: raise ValueError('UART receive FIFO underflow')
                self.put(address, queue.popleft(), size)
                if queue and self.get(base + 0xc) & 0x20: self.pend(39 if base == 0x40004800 else 38)
        if 0x40026000 <= address < 0x40026800: self.complete_dma()

    def transfer_done(self, controller, stream, control):
        base = controller + 0x10 + stream * 0x18
        self.put(base, control & ~1); self.put(base + 4, 0)
        flag = (0, 6, 16, 22)[stream % 4] + 5
        status = controller + (4 if stream >= 4 else 0)
        self.put(status, self.get(status) | 1 << flag)
        if control & 0x10:
            irq = ([11, 12, 13, 14, 15, 16, 17, 47] if controller == 0x40026000 else [56, 57, 58, 59, 60, 68, 69, 70])[stream]
            self.pend(irq)

    def complete_dma(self):
        if self.critical: self.critical.dma(self.get)
        # SPI2 full-duplex storage: DMA1 streams 3 (TX), 2 (RX).
        tx, rx = 0x40026058, 0x40026040
        tc, rc = self.get(tx), self.get(rx)
        # Historical STM32 stream addresses: stream 3=0x58, stream 2=0x40.
        # Some setup uses streams 4/3; select from configured PAR/direction.
        candidates = []
        for stream in range(8):
            base = 0x40026010 + stream * 24
            if self.get(base) & 1 and self.get(base + 8) == 0x4000380c: candidates.append((base, stream, self.get(base)))
        txs = [row for row in candidates if row[2] >> 6 & 3 == 1]; rxs = [row for row in candidates if row[2] >> 6 & 3 == 0]
        if txs and rxs:
            tx, ts, tc = txs[0]; rx, rs, rc = rxs[0]; count = self.get(tx + 4)
            width = 1 << (tc >> 13 & 3)
            if not 0 < count <= 4096 or count != self.get(rx + 4) or width not in (1, 2) or width != 1 << (rc >> 13 & 3): raise ValueError('Unsupported flash DMA geometry')
            source, target = self.get(tx + 12), self.get(rx + 12)
            for i in range(count):
                data = self.get(source + (i * width if tc & 0x400 else 0), width)
                response = bytes(self.flash.exchange(b) for b in data.to_bytes(width, 'big'))
                self.uc.mem_write(target + (i * width if rc & 0x400 else 0), response[::-1])
            self.transfer_done(0x40026000, ts, tc); self.transfer_done(0x40026000, rs, rc)
            self.trace.append(('flash-dma', count, width))
        base = 0x40026088; control = self.get(base)
        if control & 1 and self.get(base + 8) == 0x40003c0c:
            count = self.get(base + 4); width = 1 << (control >> 13 & 3)
            if (control >> 6 & 3) != 1 or width != 2 or not control & 0x400 or count != 4096: raise ValueError('Unsupported display DMA geometry')
            self.panel.frame(bytes(self.uc.mem_read(self.get(base + 12), count * width)))
            self.transfer_done(0x40026000, 5, control); self.trace.append(('display-frame', self.panel.display_frames))
        tx, rx = 0x40026458, 0x40026440
        tc, rc = self.get(tx), self.get(rx)
        if tc & 1 and rc & 1 and self.get(tx + 8) == self.get(rx + 8) == 0x4001300c and self.ticks - self.last_panel_dma >= 512:
            self.approximations.add('panel-dma-scan-timing')
            if not tc & 0x100 or not rc & 0x100 or (tc >> 6 & 3) != 1 or rc >> 6 & 3 or (tc | rc) & 0x7800:
                raise ValueError('Unsupported panel DMA configuration')
            count = self.get(tx + 4)
            if count not in (64, 128) or self.get(rx + 4) != count: raise ValueError('Unsupported panel DMA length')
            offset = 128 - count
            source, target = self.get(tx + 12) + offset, self.get(rx + 12) + offset
            for i in range(0, 64, 8): self.uc.mem_write(target + i, self.panel.scan_frame(bytes(self.uc.mem_read(source + i, 8))))
            remaining = 64 if count == 128 else 128
            self.put(tx + 4, remaining); self.put(rx + 4, remaining)
            flag = 1 << (26 if count == 128 else 27)
            self.put(0x40026400, self.get(0x40026400) | flag)
            if tc & (8 if count == 128 else 16): self.pend(59)
            self.last_panel_dma = self.ticks

    def report(self):
        return {'ticks': self.ticks, 'virtualCycles': self.cycles, 'approximations': sorted(self.approximations),
                'mmioAccesses': [hex(a) for a in sorted(self.accesses)], 'trace': list(self.trace),
                'flashSha256': hashlib.sha256(self.flash.data).hexdigest(), 'flashWrites': self.flash.writes,
                'midiOut': self.midi_out[-256:], 'usb': {'phase': self.usb.phase, 'queuedPackets': len(self.usb.pending_midi)}}
