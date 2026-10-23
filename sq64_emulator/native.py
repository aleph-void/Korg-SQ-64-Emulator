"""Native QEMU process transport; firmware execution and devices live in C."""
from pathlib import Path
import fcntl
import hashlib
import json
import struct
import sys
import tempfile
import time
import weakref

from .image import Image
from .critical import CONTRACT

ROOT = Path(__file__).resolve().parents[1]
ENGINE = next((p / 'engine' for p in ROOT.parents if (p / 'engine/avengine/qemu.py').is_file()), None)
if ENGINE is None:
    raise ImportError('The shared Aleph-Void engine transport was not found')
sys.path.insert(0, str(ENGINE))
from avengine.qemu import QemuProcess


def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()


def checked_build():
    binary = ROOT / 'build/qemu/qemu-system-arm'
    receipt = json.loads((binary.parent / 'sq64-build.json').read_text())
    sources = {str(p.relative_to(ROOT)): digest(p) for p in sorted((ROOT / 'tools/qemu').glob('sq64*'))}
    if receipt['model_sources_sha256'] != sources or digest(binary) != receipt['binary_sha256']:
        raise ValueError('Native SQ-64 build does not match the reviewed model sources')
    if digest(ROOT / 'tools/build_qemu.py') != receipt['recipe_sha256']:
        raise ValueError('Native SQ-64 build recipe changed; rebuild before execution')
    return binary, receipt


def image_elf(image):
    """Container conversion only. Preserve every caller-supplied load byte."""
    segments = image.segments
    first = next(data for address, data in segments if address == image.vector)
    entry = struct.unpack_from('<I', first, 4)[0]
    header = b'\x7fELF\x01\x01\x01' + bytes(9)
    header += struct.pack('<HHIIIIIHHHHHH', 2, 40, 1, entry, 52, 0, 0x05000000, 52, 32, len(segments), 0, 0, 0)
    offset = 52 + len(segments) * 32; table = bytearray(); content = bytearray()
    for address, data in segments:
        table += struct.pack('<8I', 1, offset, address, address, len(data), len(data), 7, 4)
        content += data; padding = -len(data) % 4; content += bytes(padding); offset += len(data) + padding
    return header + table + content


def release(resources):
    process, lease, tmp = resources
    if process: process.close()
    if lease: lease.close()
    if tmp: tmp.cleanup()


class NativeMachine:
    def __init__(self, image, *, flash_path=None, seconds=3600):
        self.image = image if isinstance(image, Image) else Image.load(image)
        binary, self.build = checked_build()
        self.resources = [None, None, None]
        self.finalizer = weakref.finalize(self, release, self.resources)
        try:
            tmp = self.resources[2] = tempfile.TemporaryDirectory(prefix='sq64-native-')
            self.path = Path(flash_path).expanduser().absolute() if flash_path else Path(tmp.name) / 'spi.bin'
            if self.path.is_symlink(): raise ValueError('SPI state must not be a symlink')
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.resources[1] = Path(str(self.path) + '.lock').open('a+b')
            fcntl.flock(self.resources[1], fcntl.LOCK_EX | fcntl.LOCK_NB)
            if self.path.exists():
                if self.path.stat().st_size != 0x1000000: raise ValueError('SPI state must be exactly 16 MiB')
            else:
                if len(self.image.spi) not in (0x100000, 0x1000000): raise ValueError('Unsupported source SPI geometry')
                self.path.write_bytes(self.image.spi.ljust(0x1000000, b'\xff'))
            elf = Path(tmp.name) / 'firmware.elf'; elf.write_bytes(image_elf(self.image))
            self.process = self.resources[0] = QemuProcess(binary, self.build['binary_sha256'],
                ['-M', 'sq64,spi-state=' + str(self.path).replace(',', ',,'), '-kernel', str(elf),
                 '-accel', 'tcg,thread=single,tb-size=16', '-icount', 'shift=0,sleep=off'],
                uart=False, wall_seconds=seconds, cpu_seconds=min(86400, max(1, int(seconds))),
                readonly_files=[elf], writable_files=[self.path])
            self.process.rsp('qSupported:xmlRegisters=arm')
            self.process.rsp('qXfer:features:read:target.xml:0,ffff')
        except BaseException:
            self.close(); raise

    def close(self): self.finalizer()
    def __enter__(self): return self
    def __exit__(self, *args): self.close()

    def pause(self):
        if self.process.qmp('query-status')['running']: self.process.qmp('stop')

    def state(self):
        self.pause()
        return json.loads(self.process.qmp('qom-get', path='/machine', property='av-state'))

    def control(self, operation, **args):
        self.pause()
        self.process.qmp('qom-set', path='/machine', property='av-control',
                         value=json.dumps(dict(operation=operation, **args)))

    def run(self, ticks=10000, *, seconds=30):
        if type(ticks) is not int or not 1 <= ticks <= 10000000: raise ValueError('Run budget must be 1..10000000 virtual ticks')
        self.control('run', ticks=ticks); deadline = time.monotonic() + seconds
        while self.process.qmp('query-status')['running']:
            if time.monotonic() >= deadline:
                self.pause(); raise TimeoutError('Native execution wall-time budget exceeded')
            time.sleep(.001)
        return self.state()

    def read(self, address, size):
        if type(address) is not int or type(size) is not int or size < 0 or size > 0x1000000:
            raise ValueError('Invalid native read range')
        self.pause(); result = bytearray()
        for offset in range(0, size, 1024):
            reply = self.process.rsp(f'm{address+offset:x},{min(1024,size-offset):x}')
            if reply.startswith('E'): raise ValueError('Native debugger rejected memory read')
            part = bytes.fromhex(reply)
            if len(part) != min(1024, size-offset): raise ValueError('Short native memory read')
            result += part
        return bytes(result)

    def write_ram(self, address, data):
        data = bytes(data)
        if not any(a <= address and address + len(data) <= b for a,b in [(0,0x4000),(0x20000000,0x20040000)]):
            raise ValueError('Debugger writes are restricted to native RAM')
        self.pause()
        for offset in range(0,len(data),1024):
            part=data[offset:offset+1024]
            if self.process.rsp(f'M{address+offset:x},{len(part):x}:'+part.hex())!='OK':
                raise RuntimeError('Native RAM write failed')

    def register(self, index):
        self.pause(); return self.process.register(index, endian='little')

    def critical_report(self, state=None):
        state = state or self.state(); fault = state.get('fault', {}); identifier = fault.get('criticalId',0)
        rows=[]
        for check in CONTRACT['checks']:
            row=dict(check,status='not-run')
            if identifier and check['id']==f'CRITICAL-{identifier:03d}':
                row.update(status='pass',imageSha256=self.image.sha256,operation=fault['operation'],
                           address=fault['address'],length=fault['size'],source=fault['source'],pc=fault['pc'])
            rows.append(row)
        return dict(format='sq64-critical-results',version=1,specVersion=CONTRACT['specVersion'],
                    terminateOnCritical=True,terminated=bool(identifier),imageSha256=self.image.sha256,
                    warning=CONTRACT['warning'] if identifier else None,claim=CONTRACT['claim'],results=rows)
