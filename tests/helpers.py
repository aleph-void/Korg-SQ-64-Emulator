"""Original tiny Thumb programs, generated in memory; never flash these."""
import struct

def image(code=bytes.fromhex('fee7')):
    data = bytearray(65536)
    struct.pack_into('<II', data, 0, 0x20040000, 0x00200009)
    data[8:8 + len(code)] = code
    return bytes(data)
