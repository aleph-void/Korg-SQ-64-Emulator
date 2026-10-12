"""SPI NOR transaction model. Command semantics are independent of firmware."""
class SpiFlash:
    def __init__(self, data=None, jedec=(0xef, 0x40, 0x14)):
        self.data = bytearray(data if data is not None else bytes([255]) * 0x100000)
        if len(self.data) != 0x100000:
            raise ValueError('SPI storage must be 1 MiB')
        self.jedec = bytes(jedec)
        self.selected = False; self.enabled = False; self.command = None
        self.position = 0; self.address = 0; self.page = 0; self.writes = 0

    def select(self, active):
        if active and self.selected:
            raise ValueError('Flash already selected')
        if not active and self.command in (2, 0x20, 0xd8, 0xc7):
            self.enabled = False
        self.selected = active
        if active:
            self.command = None; self.position = 0; self.address = 0

    def exchange(self, value):
        if not self.selected:
            raise ValueError('Flash clocked while deselected')
        result = 255
        if self.position == 0:
            if value not in (0, 2, 3, 4, 5, 6, 0x0b, 0x20, 0x9f, 0xd8):
                raise ValueError(f'Unsupported SPI flash command 0x{value:02x}')
            self.command = value
            if value == 6: self.enabled = True
            if value == 4: self.enabled = False
        elif self.command in (2, 3, 0x0b, 0x20, 0xd8) and self.position <= 3:
            self.address = (self.address << 8) | value
            if self.position == 3:
                if self.address >= len(self.data): raise ValueError('SPI address out of range')
                self.page = self.address & ~255
                if self.command in (0x20, 0xd8):
                    if not self.enabled: raise ValueError('Erase without write enable')
                    size = 4096 if self.command == 0x20 else 65536
                    start = self.address & ~(size - 1)
                    self.data[start:start + size] = bytes([255]) * size; self.writes += 1
        elif self.command in (3, 0x0b):
            if self.command != 0x0b or self.position > 4:
                result = self.data[self.address]; self.address = (self.address + 1) % len(self.data)
        elif self.command == 2:
            if not self.enabled: raise ValueError('Programming without write enable')
            self.data[self.address] &= value; self.writes += 1
            self.address = self.page | ((self.address + 1) & 255)
        elif self.command == 5: result = 2 if self.enabled else 0
        elif self.command == 0x9f: result = self.jedec[(self.position - 1) % len(self.jedec)]
        self.position += 1
        return result
