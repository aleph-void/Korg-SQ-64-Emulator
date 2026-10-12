"""Visual controls and configurable scan wiring; no firmware labels or fonts."""
BUTTONS = ['tap', 'record', 'stop', 'play', 'control', 'project', 'global', 'pattern',
           'gate', 'pitch', 'mod', 'loop', 'shift', 'bar1', 'bar2', 'bar3', 'bar4',
           'trackA', 'trackB', 'trackC', 'trackD']
PADS = [f'{track}{i + 1}' for track in 'ABCD' for i in range(16)]
ENCODERS = ['tempo', 'swing', 'param1', 'param2', 'param3', 'param4']

class Panel:
    def __init__(self, mapping=None):
        self.buttons = {name: False for name in BUTTONS + PADS}
        self.encoders = {name: 0 for name in ENCODERS}
        self.leds = {name: 0 for name in BUTTONS + PADS}
        self.mapping = mapping or {}
        for name, wire in self.mapping.items():
            if name not in self.buttons or not isinstance(wire, list) or len(wire) != 2 or not all(type(n) is int for n in wire) or not 0 <= wire[0] < 48 or not 0 <= wire[1] < 8:
                raise ValueError('Invalid panel scan mapping')
        self.rx = bytearray([255]) * 48
        self.tx = bytearray()
        self.events = []
        self.display = bytearray(8192)
        self.display_frames = 0
        self.scan_row = 0

    def event(self, event, tick):
        kind, name = event.get('type'), event.get('control')
        if kind == 'button' and name in self.buttons and type(event.get('down')) is bool:
            self.buttons[name] = event['down']
        elif kind == 'encoder' and name in self.encoders and type(event.get('delta')) is int and -128 <= event['delta'] <= 128:
            self.encoders[name] += event['delta']
        else:
            raise ValueError('Invalid panel event')
        wire = self.mapping.get(name)
        if wire is not None and kind == 'button':
            byte, bit = wire
            if not 0 <= byte < 48 or not 0 <= bit < 8: raise ValueError('Invalid scan mapping')
            if event['down']: self.rx[byte] &= ~(1 << bit)
            else: self.rx[byte] |= 1 << bit
        self.events.append({'tick': tick, **event})
        if len(self.events) > 100000: raise ValueError('Input recording capacity exceeded')

    def scan_frame(self, transmitted):
        """Eight-byte DMA frame, including two leading padding bytes.

        Row select and serial timing are provisional; a capture from physical
        hardware is required before treating this as a conformance oracle.
        """
        if len(transmitted) != 8: raise ValueError('Invalid panel SPI frame')
        response = bytes([255, 255]) + bytes(self.rx[self.scan_row * 6:self.scan_row * 6 + 6])
        row_mask = transmitted[2]
        if row_mask and not row_mask & (row_mask - 1): self.scan_row = row_mask.bit_length() - 1
        self.tx.extend(transmitted)
        if len(self.tx) > 8192: del self.tx[:4096]
        return response

    def frame(self, data):
        if len(data) != 8192: raise ValueError('Display transfer must be 8192 bytes in this profile')
        self.display[:] = data; self.display_frames += 1

    def snapshot(self):
        return {'buttons': self.buttons.copy(), 'encoders': self.encoders.copy(), 'leds': self.leds.copy(),
                'display': self.display.hex(), 'displayFrames': self.display_frames,
                'mappedControls': sorted(self.mapping), 'wiringVerified': False}
