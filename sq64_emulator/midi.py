"""OS MIDI ports, with bounded queues between callbacks and the CPU thread."""
import queue
import sys

class MidiMessages:
    def __init__(self): self.pending = []; self.status = None
    def feed(self, value):
        if value >= 0xf8: return [[value]]
        if value == 0xf0: self.pending = [value]; self.status = value; return []
        if value == 0xf7:
            result = [self.pending + [value]] if self.status == 0xf0 else []
            self.pending = []; self.status = None; return result
        if value & 0x80:
            self.status = value; self.pending = [value]
            if value == 0xf6: self.pending = []; self.status = None; return [[value]]
            return []
        if self.status is None: return []
        if not self.pending: self.pending = [self.status]
        self.pending.append(value)
        if len(self.pending) > 16384: self.pending = []; self.status = None; raise ValueError('MIDI message too large')
        if self.status == 0xf0: return []
        length = 2 if (self.status >> 4 in (0xc, 0xd) or self.status in (0xf1, 0xf3)) else 3
        if len(self.pending) == length:
            message = self.pending; self.pending = []
            if self.status >= 0xf0: self.status = None
            return [message]
        return []

class MidiBridge:
    def __init__(self, *, name='Aleph Void SQ-64 Emulator', input_port=None, output_port=None, backend=None, transport='usb'):
        if backend is None:
            try: import rtmidi as backend
            except ImportError as error: raise RuntimeError('Install the midi extra: pip install -e ".[midi]"') from error
        self.incoming = queue.Queue(maxsize=1024); self.error = None
        self.input = backend.MidiIn(); self.output = backend.MidiOut(); self.parser = MidiMessages()
        self.name = name; self.output_index = 0
        self.transport = transport
        try:
            self.input.ignore_types(sysex=False, timing=False, active_sense=False)
            if input_port is not None and output_port is not None:
                ins, outs = self.input.get_ports(), self.output.get_ports()
                if input_port not in ins or output_port not in outs: raise RuntimeError('Configured MIDI ports were not found')
                self.input.open_port(ins.index(input_port), name + ' input'); self.output.open_port(outs.index(output_port), name + ' output')
            elif sys.platform == 'win32':
                raise RuntimeError('WinMM cannot create virtual ports. Select an existing input/output port pair. The browser emulator needs neither.')
            else:
                self.input.open_virtual_port(name + ' input'); self.output.open_virtual_port(name + ' output')
            self.input.set_callback(self.receive)
        except Exception:
            self.close(); raise

    def receive(self, event, data=None):
        message, timestamp = event
        try: self.incoming.put_nowait(bytes(message))
        except queue.Full: self.error = 'MIDI input queue overflow; execution paused'

    def pump(self, machine):
        if self.error: raise RuntimeError(self.error)
        while not self.incoming.empty(): machine.board.inject_midi(self.incoming.get_nowait(), port=self.transport)
        for row in machine.board.midi_out:
            if row['sequence'] <= self.output_index: continue
            if self.accepts(row):
                for message in self.parser.feed(row['byte']): self.output.send_message(message)
            self.output_index = row['sequence']

    def accepts(self, row):
        # The sequencer USB cable is 2. Do not mix separate DIN/USB byte streams.
        return row['port'] == 'usb' and row.get('cable', 0) == 2 if self.transport == 'usb' else row['port'] == 0x40004800

    def close(self):
        for port in (self.input, self.output):
            try: port.close_port()
            except Exception: pass

    def status(self): return {'name': self.name, 'error': self.error, 'transport': self.transport, 'ports': 'registered'}

def open_bridge(*, input_port=None, output_port=None, transport='usb'):
    if bool(input_port) != bool(output_port): raise ValueError('Specify both MIDI input and output ports')
    return MidiBridge(input_port=input_port, output_port=output_port, transport=transport)
