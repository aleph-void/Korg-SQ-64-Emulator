"""MIDI 1.0 bytes <-> UMP, including fragmented SysEx7, without device content."""
def encode(message):
    if not message or not all(type(b) is int and 0 <= b <= 255 for b in message): raise ValueError('Invalid MIDI message')
    status = message[0]
    if status == 0xf0:
        if message[-1] != 0xf7 or any(b >= 128 for b in message[1:-1]): raise ValueError('Invalid SysEx')
        payload = message[1:-1]
        packets = []
        for offset in range(0, max(1, len(payload)), 6):
            chunk = payload[offset:offset + 6]
            kind = 0 if len(payload) <= 6 else 1 if offset == 0 else 3 if offset + 6 >= len(payload) else 2
            raw = bytes([0x30, kind << 4 | len(chunk), *chunk]) + bytes(6 - len(chunk))
            packets.append([int.from_bytes(raw[:4], 'big'), int.from_bytes(raw[4:], 'big')])
        return packets
    if status < 0x80: raise ValueError('MIDI status required')
    length = (2 if status >> 4 in (0xc, 0xd) else 3) if status < 0xf0 else {0xf1: 2, 0xf2: 3, 0xf3: 2, 0xf6: 1, 0xf8: 1, 0xfa: 1, 0xfb: 1, 0xfc: 1, 0xfe: 1, 0xff: 1}.get(status)
    if length != len(message) or any(b >= 128 for b in message[1:]): raise ValueError('Invalid MIDI message length/data')
    raw = bytes([0x20 if status < 0xf0 else 0x10, *message]) + bytes(3 - len(message))
    return [[int.from_bytes(raw, 'big')]]

class Decoder:
    def __init__(self): self.sysex = None
    def decode(self, words):
        if not isinstance(words, list) or not 1 <= len(words) <= 4 or not all(type(w) is int and 0 <= w < 2**32 for w in words): raise ValueError('Invalid UMP words')
        raw = b''.join(w.to_bytes(4, 'big') for w in words); kind = raw[0] >> 4
        if raw[0] & 15: raise ValueError('Only UMP group zero is exposed')
        if kind in (1, 2) and len(words) == 1:
            status = raw[1]
            length = (2 if status >> 4 in (0xc, 0xd) else 3) if kind == 2 else {0xf1: 2, 0xf2: 3, 0xf3: 2, 0xf6: 1, 0xf8: 1, 0xfa: 1, 0xfb: 1, 0xfc: 1, 0xfe: 1, 0xff: 1}.get(status)
            if not length: raise ValueError('Unsupported system message')
            message = list(raw[1:1 + length]); encode(message); return message
        if kind == 3 and len(words) == 2:
            state, count = raw[1] >> 4, raw[1] & 15
            if state > 3 or count > 6 or any(b >= 128 for b in raw[2:2 + count]): raise ValueError('Malformed SysEx7 packet')
            if state in (0, 1): self.sysex = [0xf0]
            elif self.sysex is None: raise ValueError('SysEx continuation without start')
            self.sysex.extend(raw[2:2 + count])
            if len(self.sysex) > 16384: self.sysex = None; raise ValueError('SysEx too large')
            if state in (0, 3): result = self.sysex + [0xf7]; self.sysex = None; return result
            return []
        raise ValueError('Unsupported UMP type for MIDI 1.0 firmware')
