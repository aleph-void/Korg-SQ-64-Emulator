import contract from './critical-spec.js';
const overlaps = (a, n, b, size) => a < b + size && b < a + n;
export class CriticalHazard extends Error {}
export class CriticalMonitor {
  constructor(imageSha256) { this.imageSha256 = imageSha256; this.hit = null; }
  trip(id, operation, address, length, source = 'cpu') {
    this.hit ||= {...contract.checks.find(c => c.id === id), status: 'pass', imageSha256: this.imageSha256, operation, address, length, source};
    throw new CriticalHazard(contract.warning);
  }
  memory(a, n, v, source = 'cpu') {
    if (this.hit) throw new CriticalHazard(contract.warning);
    if (overlaps(a, n, 0x200000, 0x100000) || overlaps(a, n, 0x8000000, 0x200000)) this.trip('CRITICAL-001', 'internal-flash-write', a, n, source);
    if (overlaps(a, n, 0x1ff00000, 0x100000) || overlaps(a, n, 0x40023c08, 4) || overlaps(a, n, 0x40023c14, 12)) this.trip('CRITICAL-002', 'system-or-option-write', a, n, source);
    if (overlaps(a, n, 0x40023c10, 4)) {
      const bits = a <= 0x40023c10 ? v >>> ((0x40023c10 - a) * 8) : v * 2 ** ((a - 0x40023c10) * 8);
      if (v === undefined || bits & 6) this.trip('CRITICAL-001', 'internal-flash-erase-armed', a, n, source);
    }
  }
  spi(operation, address, length) {
    if (address < 0x30000 && address + length > 0) this.trip('CRITICAL-004', operation, address, length, 'spi-flash');
  }
  command(value) {
    if (![0, 2, 3, 4, 5, 6, 11, 32, 159, 216].includes(value)) this.trip('CRITICAL-003', `spi-command-0x${value.toString(16)}`, null, null, 'spi-flash');
  }
  dma(get) {
    for (const controller of [0x40026000, 0x40026400]) for (let stream = 0; stream < 8; stream++) {
      const base = controller + 16 + stream * 24, c = get(base);
      if (!(c & 1)) continue;
      const peripheral = (c >>> 6 & 3) === 1, width = 1 << (c >>> (peripheral ? 11 : 13) & 3);
      const length = (c & (peripheral ? 512 : 1024)) ? Math.max(1, get(base + 4) & 65535) * width : width;
      const offsets = peripheral ? [8] : c & 0x40000 ? [12, 16] : [12];
      for (const offset of offsets) {
        const a = get(base + offset);
        if (a + length > 0x100000000) this.trip('CRITICAL-005', 'dma-address-wrap', a, length, 'dma');
        this.memory(a, length, undefined, 'dma');
      }
    }
  }
  dmaWrite(a, n, v, get) {
    if (!overlaps(a, n, 0x40026000, 0x800)) return;
    this.dma(address => { let value = get(address); for (let i = 0; i < 4; i++) if (address + i >= a && address + i < a + n) value = (value & ~(255 << (8 * i))) | ((v >>> (8 * (address + i - a)) & 255) << (8 * i)); return value >>> 0; });
  }
  report() { return {format: 'sq64-critical-results', version: 1, specVersion: contract.specVersion, terminateOnCritical: true, terminated: !!this.hit, imageSha256: this.imageSha256, warning: this.hit ? contract.warning : null, claim: contract.claim, results: contract.checks.map(c => this.hit?.id === c.id ? {...this.hit} : {...c, status: 'not-run'})}; }
}
