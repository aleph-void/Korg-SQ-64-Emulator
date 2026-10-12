import unittest
from types import SimpleNamespace
from sq64_emulator.midi import MidiMessages, MidiBridge
from sq64_emulator.usb import midi_packets, packet_bytes, UsbDevice
from sq64_emulator.ump import encode, Decoder

class MidiTests(unittest.TestCase):
    def test_running_status_realtime_and_sysex(self):
        parser = MidiMessages(); messages = []
        for byte in [0x90, 60, 0xf8, 100, 61, 0, 0xf0, 1, 2, 0xf7]: messages.extend(parser.feed(byte))
        self.assertEqual(messages, [[0xf8], [0x90, 60, 100], [0x90, 61, 0], [0xf0, 1, 2, 0xf7]])

    def test_usb_roundtrip_all_sysex_tail_lengths(self):
        for length in range(20):
            message = bytes([240]) + bytes(range(length)) + bytes([247])
            packets = packet_bytes(midi_packets(message))
            self.assertEqual(b''.join(p[1] for p in packets), message)
            self.assertTrue(all(p[0] == 2 for p in packets))
        for message in [bytes([0x90, 60, 127]), bytes([0xc0, 12]), bytes([0xf8])]:
            self.assertEqual(packet_bytes(midi_packets(message))[0][1], message)

    def test_usb_rejects_invalid_messages(self):
        for message in [[0x90, 1], [0xf4], [0xf0, 255, 247], [0x90, 128, 0]]:
            with self.assertRaises(ValueError): midi_packets(message)
        with self.assertRaises(ValueError): packet_bytes(b'\x00')

    def test_ump_roundtrips_fragmentation(self):
        for length in range(25):
            message = [240, *range(length), 247]; decoder = Decoder(); result = []
            for packet in encode(message): result.extend(decoder.decode(packet))
            self.assertEqual(result, message)
        for message in [[0x90, 60, 1], [0xd2, 0], [0xf2, 1, 2], [0xfa]]:
            self.assertEqual(Decoder().decode(encode(message)[0]), message)

    def test_ump_rejects_continuation_without_start(self):
        with self.assertRaises(ValueError): Decoder().decode([0x30210000, 0])

    def test_virtual_registration_and_bidirectional_bridge(self):
        class Port:
            def __init__(self): self.sent = []; self.name = None
            def ignore_types(self, **kwargs): self.filters = kwargs
            def open_virtual_port(self, name): self.name = name
            def set_callback(self, callback): self.callback = callback
            def send_message(self, message): self.sent.append(message)
            def close_port(self): self.name = None
        backend = SimpleNamespace(MidiIn=Port, MidiOut=Port)
        import unittest.mock
        with unittest.mock.patch('sq64_emulator.midi.sys.platform', 'linux'):
            bridge = MidiBridge(backend=backend)
        received = []; board = SimpleNamespace(inject_midi=lambda data, **kwargs: received.append(data), midi_out=[])
        bridge.receive(([0x90, 60, 100], 0)); bridge.pump(SimpleNamespace(board=board))
        self.assertEqual(received, [bytes([0x90, 60, 100])])
        board.midi_out = [{'sequence': i + 1, 'port': 'usb', 'cable': 2, 'byte': b} for i, b in enumerate([0x90, 60, 0])]
        bridge.pump(SimpleNamespace(board=board)); bridge.pump(SimpleNamespace(board=board))
        self.assertEqual(bridge.output.sent, [[0x90, 60, 0]])
        self.assertFalse(bridge.input.filters['sysex']); self.assertIn('Aleph Void', bridge.input.name)
        bridge.close()

class UsbTests(unittest.TestCase):
    def setUp(self):
        self.irqs = []; self.output = []
        self.usb = UsbDevice(SimpleNamespace(pend=self.irqs.append, emit_midi=lambda byte, **kw: self.output.append((byte, kw))))

    def test_setup_fifo_and_read_pop(self):
        self.usb.setup(bytes([0x80, 6, 0, 2, 0, 0, 255, 0]))
        self.assertEqual(self.usb.read(0x1c), self.usb.read(0x20))
        self.assertEqual(self.usb.read(0x1000), 0x02000680)
        self.assertEqual(self.usb.read(0x1000), 0x00ff0000)

    def test_bulk_in_is_firmware_output(self):
        payload = midi_packets([0x90, 60, 100])
        self.usb.write(0x930, 4); self.usb.write(0x2000, int.from_bytes(payload, 'little'))
        self.assertEqual([x[0] for x in self.output], [0x90, 60, 100])
        self.assertEqual(self.usb.read(0x928), 1)
        self.usb.write(0x928, 1); self.assertEqual(self.usb.read(0x928), 0)

    def test_multi_packet_control_descriptor(self):
        self.usb.setup([0x80, 6, 0, 2, 0, 0, 255, 0])
        descriptor = bytes([9, 2, 70, 0]) + bytes(66)
        for chunk in [descriptor[:64], descriptor[64:]]:
            self.usb.write(0x910, len(chunk))
            padded = chunk + bytes(-len(chunk) % 4)
            for i in range(0, len(padded), 4): self.usb.write(0x1000, int.from_bytes(padded[i:i + 4], 'little'))
            self.assertEqual(self.usb.setup_active is None, len(chunk) < 64)
        self.assertEqual(self.usb.config, descriptor)

    def test_bulk_out_waits_for_endpoint_enable(self):
        self.usb.phase = 'configured'; self.usb.inject([0xf8]); self.usb.service()
        self.assertEqual(len(self.usb.rx), 0)
        self.usb.write(0xb20, 1 << 31); self.usb.service(); self.assertEqual(len(self.usb.rx), 1)
