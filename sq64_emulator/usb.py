"""USB OTG FS device-side transaction model and MIDI event packet adapter.

Descriptors and replies come from the running firmware. No host protocol
response is substituted for candidate execution. Electrical signaling and USB
microframe timing are outside this model.
"""
from collections import deque

def midi_packets(data, cable=2):
    if not 0 <= cable < 16: raise ValueError('Invalid USB MIDI cable')
    data = bytes(data)
    if not data: return b''
    if data[0] == 0xf0:
        if data[-1] != 0xf7 or any(b >= 128 for b in data[1:-1]): raise ValueError('Incomplete or malformed SysEx')
        result = bytearray()
        for i in range(0, len(data), 3):
            chunk = data[i:i + 3]; cin = 4 if i + 3 < len(data) else 4 + len(chunk)
            result.extend(bytes([cable << 4 | cin]) + chunk + bytes(3 - len(chunk)))
        return bytes(result)
    status = data[0]
    if status in (0xf4, 0xf5, 0xf7, 0xf9, 0xfd) or any(b >= 128 for b in data[1:]): raise ValueError('Invalid MIDI data')
    cin = status >> 4 if status < 0xf0 else {0xf1: 2, 0xf2: 3, 0xf3: 2, 0xf6: 5}.get(status, 15)
    expected = {2: 2, 3: 3, 5: 1, 8: 3, 9: 3, 10: 3, 11: 3, 12: 2, 13: 2, 14: 3, 15: 1}.get(cin)
    if expected != len(data) or status < 128: raise ValueError('Invalid MIDI packet length')
    return bytes([cable << 4 | cin]) + data + bytes(3 - len(data))

def packet_bytes(data):
    if len(data) % 4: raise ValueError('USB MIDI transfer is not a multiple of four bytes')
    lengths = {2: 2, 3: 3, 4: 3, 5: 1, 6: 2, 7: 3, 8: 3, 9: 3, 10: 3, 11: 3, 12: 2, 13: 2, 14: 3, 15: 1}
    result = []
    for i in range(0, len(data), 4):
        length = lengths.get(data[i] & 15)
        if length is None: raise ValueError('Unsupported USB MIDI CIN')
        result.append((data[i] >> 4, data[i + 1:i + 1 + length]))
    return result

class UsbDevice:
    BASE = 0x50000000
    def __init__(self, board):
        self.board = board; self.regs = {}; self.rx = deque(); self.fifo = deque()
        self.tx = {}; self.tx_expected = {}; self.in_interrupt = {}; self.out_interrupt = {}
        self.global_status = 0; self.phase = 'disconnected'; self.setup_active = None
        self.config = bytearray(); self.pending_midi = deque(); self.bulk_out = 1; self.bulk_in = 1
        self.transitions = []

    def reg(self, offset): return self.regs.get(offset, 0)
    def in_status(self, ep):
        return self.in_interrupt.get(ep, 0) | (128 if self.tx_expected.get(ep, 0) > len(self.tx.get(ep, b'')) else 0)
    def status(self):
        value = self.global_status
        if self.rx: value |= 1 << 4
        if any(self.reg(0x81c) & 1 << ep and self.in_status(ep) & (self.reg(0x810) | (128 if self.reg(0x834) & 1 << ep else 0)) for ep in range(6)): value |= 1 << 18
        if any(self.reg(0x81c) & 1 << (16 + ep) and v & self.reg(0x814) for ep, v in self.out_interrupt.items()): value |= 1 << 19
        return value

    def signal(self):
        if self.reg(8) & 1 and self.status() & self.reg(0x18): self.board.pend(67)

    def read(self, offset):
        if offset == 0x10: return 0x80000000
        if offset == 0x14: return self.status()
        if offset in (0x1c, 0x20):
            if not self.rx: return 0
            endpoint, kind, payload = self.rx[0] if offset == 0x1c else self.rx.popleft()
            if offset == 0x20 and payload:
                padded = payload + bytes((-len(payload)) % 4)
                self.fifo.extend(int.from_bytes(padded[i:i + 4], 'little') for i in range(0, len(padded), 4))
            return endpoint | len(payload) << 4 | kind << 17
        if offset == 0x818:
            return sum(1 << e for e in range(6) if self.in_status(e)) | sum(1 << (16 + e) for e, v in self.out_interrupt.items() if v)
        if offset == 0x808: return 6  # ENUMSPD: full speed using the 48 MHz PHY
        if 0x900 <= offset < 0xa00 and offset % 0x20 == 8: return self.in_status((offset - 0x900) // 0x20)
        if 0xb00 <= offset < 0xc00 and offset % 0x20 == 8: return self.out_interrupt.get((offset - 0xb00) // 0x20, 0)
        if 0x900 <= offset < 0xa00 and offset % 0x20 == 0x18: return 1024
        if offset >= 0x1000:
            if offset != 0x1000 or not self.fifo: raise ValueError('USB RX FIFO underflow or unsupported FIFO read')
            return self.fifo.popleft()
        return self.reg(offset)

    def write(self, offset, value):
        if offset == 0x14: self.global_status &= ~value; self.signal(); return
        if 0x900 <= offset < 0xa00 and offset % 0x20 == 8:
            ep = (offset - 0x900) // 0x20; self.in_interrupt[ep] = self.in_interrupt.get(ep, 0) & ~value; return
        if 0xb00 <= offset < 0xc00 and offset % 0x20 == 8:
            ep = (offset - 0xb00) // 0x20; self.out_interrupt[ep] = self.out_interrupt.get(ep, 0) & ~value; return
        self.regs[offset] = value
        if 0x900 <= offset < 0xa00 and offset % 0x20 == 0x10:
            ep = (offset - 0x900) // 0x20; self.tx_expected[ep] = value & 0x7ffff; self.tx[ep] = bytearray()
        if 0x900 <= offset < 0xa00 and offset % 0x20 == 0 and value & 1 << 31:
            ep = (offset - 0x900) // 0x20
            if self.tx_expected.get(ep) == 0: self.finish_in(ep)
        if offset >= 0x1000:
            ep = (offset - 0x1000) // 0x1000
            if offset % 0x1000 or ep > 5: raise ValueError('Unsupported USB TX FIFO')
            self.tx.setdefault(ep, bytearray()).extend(value.to_bytes(4, 'little'))
            if ep in self.tx_expected and len(self.tx[ep]) >= self.tx_expected[ep]: self.finish_in(ep)

    def finish_in(self, ep):
        data = bytes(self.tx.get(ep, b''))[:self.tx_expected.get(ep, 0)]
        self.in_interrupt[ep] = self.in_interrupt.get(ep, 0) | 1
        if ep == 0:
            complete = True
            if self.setup_active and self.setup_active[1] == 6 and self.setup_active[3] == 2:
                self.config.extend(data)
                expected = int.from_bytes(self.setup_active[6:8], 'little')
                if len(self.config) >= 4: expected = min(expected, int.from_bytes(self.config[2:4], 'little'))
                complete = len(data) < 64 or len(self.config) >= expected
            # Host status stage for control-IN. Zero-length control-OUT ACK
            # needs no extra OUT status packet.
            if complete and self.setup_active and self.setup_active[0] & 0x80:
                self.rx.append((0, 2, b'')); self.out_interrupt[0] = self.out_interrupt.get(0, 0) | 1
            if complete: self.setup_active = None
        else:
            for cable, payload in packet_bytes(data):
                for b in payload: self.board.emit_midi(b, port='usb', cable=cable)
        self.tx[ep] = bytearray(); self.tx_expected.pop(ep, None); self.signal()

    def setup(self, payload):
        self.setup_active = bytes(payload)
        self.rx.append((0, 6, bytes(payload))); self.rx.append((0, 4, b''))
        self.out_interrupt[0] = self.out_interrupt.get(0, 0) | 8
        self.signal()

    def service(self):
        if self.reg(0x804) & 2: return
        if self.phase == 'disconnected' and self.reg(0x18) & 1 << 12:
            self.global_status |= 1 << 12; self.phase = 'reset'; self.signal(); return
        if self.phase == 'reset' and not self.global_status & 1 << 12:
            self.global_status |= 1 << 13; self.phase = 'enumeration'; self.signal(); return
        if self.phase == 'enumeration' and not self.global_status & 1 << 13:
            self.setup([0, 5, 1, 0, 0, 0, 0, 0]); self.phase = 'address'; return
        if self.phase == 'address' and self.setup_active is None:
            self.setup([0x80, 6, 0, 2, 0, 0, 255, 0]); self.phase = 'descriptors'; return
        if self.phase == 'descriptors' and self.setup_active is None:
            offset = 0
            while offset + 2 <= len(self.config):
                size, kind = self.config[offset:offset + 2]
                if size < 2 or offset + size > len(self.config): break
                if kind == 5 and size >= 7 and self.config[offset + 3] & 3 == 2:
                    ep = self.config[offset + 2]
                    if ep & 128: self.bulk_in = ep & 15
                    else: self.bulk_out = ep & 15
                offset += size
            self.setup([0, 9, 1, 0, 0, 0, 0, 0]); self.phase = 'configure'; return
        if self.phase == 'configure' and self.setup_active is None: self.phase = 'configured'
        if self.phase == 'configured' and self.pending_midi and not self.rx and not self.fifo:
            endpoint = self.bulk_out
            if self.reg(0xb00 + endpoint * 0x20) & 1 << 31:
                payload = self.pending_midi.popleft(); self.rx.append((endpoint, 2, payload))
                self.out_interrupt[endpoint] = self.out_interrupt.get(endpoint, 0) | 1
                self.signal()
        self.signal()

    def inject(self, message):
        data = midi_packets(message)
        if len(self.pending_midi) + (len(data) + 63) // 64 > 1024: raise ValueError('USB MIDI receive queue overflow')
        for start in range(0, len(data), 64): self.pending_midi.append(data[start:start + 64])
