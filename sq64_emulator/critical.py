"""Default-on emulator tripwires. A critical pass means a hazard was detected."""
import json
from pathlib import Path
CONTRACT = json.loads((Path(__file__).parent / '_vendor/sq64_spec/critical.json').read_text(encoding='utf-8'))
def overlaps(a, n, b, size): return a < b + size and b < a + n
class CriticalHazard(ValueError): pass
class CriticalMonitor:
    def __init__(self, image_sha256): self.image_sha256 = image_sha256; self.hit = None
    def trip(self, identifier, operation, address, length, source='cpu'):
        if self.hit is None:
            self.hit = dict(next(c for c in CONTRACT['checks'] if c['id'] == identifier), status='pass', imageSha256=self.image_sha256, operation=operation, address=address, length=length, source=source)
        raise CriticalHazard(CONTRACT['warning'])
    def memory(self, a, n, value=None, source='cpu'):
        if self.hit: raise CriticalHazard(CONTRACT['warning'])
        if overlaps(a,n,0x200000,0x100000) or overlaps(a,n,0x8000000,0x200000): self.trip('CRITICAL-001','internal-flash-write',a,n,source)
        if overlaps(a,n,0x1ff00000,0x100000) or overlaps(a,n,0x40023c08,4) or overlaps(a,n,0x40023c14,12): self.trip('CRITICAL-002','system-or-option-write',a,n,source)
        if overlaps(a,n,0x40023c10,4):
            bits = None if value is None else value >> ((0x40023c10-a)*8) if a <= 0x40023c10 else value << ((a-0x40023c10)*8)
            if bits is None or bits & 6: self.trip('CRITICAL-001','internal-flash-erase-armed',a,n,source)
    def spi(self, operation, address, length):
        if address < 0x30000 and address + length > 0: self.trip('CRITICAL-004',operation,address,length,'spi-flash')
    def command(self, value):
        if value not in (0,2,3,4,5,6,11,32,159,216): self.trip('CRITICAL-003',f'spi-command-0x{value:x}',None,None,'spi-flash')
    def dma(self, get):
        for controller in (0x40026000,0x40026400):
            for stream in range(8):
                base = controller + 16 + stream*24; c = get(base)
                if not c & 1: continue
                peripheral = (c >> 6 & 3) == 1
                width = 1 << (c >> (11 if peripheral else 13) & 3)
                length = max(1,get(base+4)&65535)*width if c & (512 if peripheral else 1024) else width
                offsets = (8,) if peripheral else (12,16) if c & 0x40000 else (12,)
                for offset in offsets:
                    a = get(base+offset)
                    if a+length > 0x100000000: self.trip('CRITICAL-005','dma-address-wrap',a,length,'dma')
                    self.memory(a,length,None,'dma')
    def dma_write(self,a,n,v,get):
        if not overlaps(a,n,0x40026000,0x800): return
        def overlay(address):
            value = get(address)
            for i in range(4):
                if a <= address+i < a+n: value = (value & ~(255 << (8*i))) | (((v >> (8*(address+i-a))) & 255) << (8*i))
            return value
        self.dma(overlay)
    def report(self):
        return dict(format='sq64-critical-results',version=1,specVersion=CONTRACT['specVersion'],terminateOnCritical=True,terminated=bool(self.hit),imageSha256=self.image_sha256,warning=CONTRACT['warning'] if self.hit else None,claim=CONTRACT['claim'],results=[dict(self.hit) if self.hit and self.hit['id']==c['id'] else dict(c,status='not-run') for c in CONTRACT['checks']])
