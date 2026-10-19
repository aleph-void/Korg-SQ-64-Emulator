export const SPI_SIZE = 16 * 1024 * 1024;
// Positive, configurable virtual-cycle delays exercise firmware polling. They
// are experiment parameters, not a measurement of the physical flash part.
export class SpiFlash {
  constructor(data = new Uint8Array(SPI_SIZE).fill(255), critical = null,
              {clock = null, programCycles = 1024, eraseCycles = 65536, blockCycles = 262144} = {}) {
    if (data.length !== SPI_SIZE) throw Error('SPI flash must be 16 MiB');
    this.delays = {2: programCycles, 32: eraseCycles, 216: blockCycles};
    if (Object.values(this.delays).some(v => !Number.isSafeInteger(v) || v < 1)) throw Error('Invalid flash cycle delay');
    this.now = 0; this.clock = clock || (() => this.now); this.operation = null;
    this.critical = critical; this.data = data.slice(); this.selected = false; this.enabled = false; this.writes = 0;
    this.latch = new Map();
  }
  advance(cycle = this.clock()) {
    if (!Number.isSafeInteger(cycle) || cycle < this.now) throw Error('Flash clock moved backwards');
    this.now = cycle;
    const op = this.operation;
    if (!op || cycle < op.deadline) return;
    if (op.command === 2) {
      for (const [address, value] of op.latch) this.data[address] &= value;
      this.writes += op.latch.size;
    } else { this.data.fill(255, op.start, op.start + op.size); this.writes++; }
    this.operation = null; this.enabled = false;
  }
  powerCut() {
    // One deterministic fault outcome; physical torn-bit patterns are unknown.
    this.advance(); this.operation = null; this.selected = this.enabled = false;
    this.command = null; this.latch.clear();
  }
  guard(callback) {
    try { callback(); }
    catch (error) { this.command = null; this.latch.clear(); throw error; }
  }
  select(active) {
    this.advance();
    if (active && this.selected) throw Error('Flash already selected');
    if (!active && this.selected && !this.operation) {
      if ([4, 6].includes(this.command) && this.position === 1) this.enabled = this.command === 6;
      else if (this.enabled && (this.command === 2 && this.position > 4 ||
               [32, 216].includes(this.command) && this.position === 4)) {
        const size = this.command === 32 ? 4096 : 65536;
        this.operation = {command: this.command, deadline: this.now + this.delays[this.command],
          latch: new Map(this.latch), start: this.address & ~(size - 1), size};
      }
    }
    this.selected = active;
    if (active) { this.position = 0; this.address = 0; this.command = null; this.latch.clear(); }
  }
  exchange(value) {
    this.advance();
    if (!this.selected) throw Error('SPI flash clocked while deselected');
    let result = 255;
    if (this.position === 0) {
      this.guard(() => this.critical?.command(value));
      if (this.operation && value !== 5) this.command = -1;
      else {
        if (![0, 2, 3, 4, 5, 6, 11, 32, 159, 216].includes(value)) throw Error(`Unmodeled flash command ${value}`);
        this.command = value;
      }
    } else if ([2, 3, 11, 32, 216].includes(this.command) && this.position <= 3) {
      this.address = this.address * 256 + value;
      if (this.position === 3) {
        if (this.address >= this.data.length) throw Error('SPI address out of range');
        this.page = this.address & ~255;
        if ([32, 216].includes(this.command)) {
          const size = this.command === 32 ? 4096 : 65536, start = this.address & ~(size - 1);
          this.guard(() => this.critical?.spi('erase', start, size));
        }
      }
    } else if ([3, 11].includes(this.command)) {
      if (this.command !== 11 || this.position > 4) { result = this.data[this.address]; this.address = (this.address + 1) % this.data.length; }
    } else if (this.command === 2) {
      this.guard(() => this.critical?.spi('program', this.address, 1, value));
      this.latch.set(this.address, value); this.address = this.page | ((this.address + 1) & 255);
    } else if (this.command === 5) result = (this.enabled ? 2 : 0) | (this.operation ? 1 : 0);
    else if (this.command === 159) result = [239, 64, 24][(this.position - 1) % 3];
    this.position++; return result;
  }
}
