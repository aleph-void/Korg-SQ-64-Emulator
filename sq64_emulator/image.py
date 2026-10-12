"""Load caller-owned images without bundling or reconstructing vendor data."""
from dataclasses import dataclass
import hashlib
import io
import struct

FLASH = 0x00200000
FLASH_SIZE = 0x10000
SRAM = 0x20000000
SRAM_SIZE = 0x40000
PAYLOAD_SIZE = 0x38000

@dataclass
class Image:
    segments: list
    spi: bytes
    vector: int
    sha256: str
    format: str

    @classmethod
    def load(cls, content):
        content = bytes(content)
        digest = hashlib.sha256(content).hexdigest()
        if content.startswith(b'\x7fELF'):
            from elftools.elf.elffile import ELFFile
            elf = ELFFile(io.BytesIO(content))
            if elf['e_machine'] != 'EM_ARM' or not elf.little_endian or elf.elfclass != 32:
                raise ValueError('Expected a little-endian ARM32 ELF')
            segments = []
            for segment in elf.iter_segments():
                if segment['p_type'] != 'PT_LOAD' or not segment['p_filesz']:
                    continue
                address = segment['p_paddr']
                if 0x08000000 <= address < 0x08010000:
                    address -= 0x07e00000
                data = segment.data()
                if not any(base <= address and address + len(data) <= base + size for base, size in [(FLASH, FLASH_SIZE), (0, 0x4000), (SRAM, SRAM_SIZE)]):
                    raise ValueError('ELF segment outside modeled memory')
                if any(address < old + len(raw) and old < address + len(data) for old, raw in segments):
                    raise ValueError('Overlapping ELF segments')
                segments.append((address, data))
            if not any(a == FLASH and len(d) >= 8 for a, d in segments):
                raise ValueError('ELF must contain a reset vector at 0x00200000')
            result = cls(segments, bytes([255]) * 0x100000, FLASH, digest, 'elf')
        else:
            kind = 'bin'
            if content.startswith(b'KORG SYSTEM FILE'):
                if len(content) != 256 + PAYLOAD_SIZE or content[0x29] != 0 or content[0x2c:0x30] != bytes([0, 1, 0x60, 255]):
                    raise ValueError('Unsupported VSB product or length')
                if struct.unpack_from('<4I', content, 0x30) != (0, PAYLOAD_SIZE, 0, PAYLOAD_SIZE):
                    raise ValueError('Unsupported VSB geometry')
                content = content[256:]; kind = 'vsb'
            if len(content) not in (FLASH_SIZE, PAYLOAD_SIZE):
                raise ValueError('Expected 64 KiB flash, 224 KiB system payload, VSB, or ARM ELF')
            spi = bytearray([255]) * 0x100000
            if len(content) == PAYLOAD_SIZE:
                for start, destination, size in ((0x10000, 0, 0x4000), (0x34000, 0x4000, 0x4000), (0x14000, 0x10000, 0x20000)):
                    spi[destination:destination + size] = content[start:start + size]
            result = cls([(FLASH, content[:FLASH_SIZE])], bytes(spi), FLASH, digest, kind)
        vector = next(data for address, data in result.segments if address == FLASH)
        stack, reset = struct.unpack_from('<2I', vector)
        if not SRAM < stack <= SRAM + SRAM_SIZE or stack % 8:
            raise ValueError('Invalid reset stack')
        if not reset & 1 or not any(a <= reset & ~1 < a + len(d) for a, d in result.segments):
            raise ValueError('Reset vector must point to loaded Thumb code')
        return result
