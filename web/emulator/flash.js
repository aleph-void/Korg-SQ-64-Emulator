export const SPI_SIZE = 16 * 1024 * 1024;
export class SpiFlash {
  constructor(data = new Uint8Array(SPI_SIZE).fill(255), critical = null) {
    if (data.length !== SPI_SIZE) throw Error('SPI flash must be 16 MiB');
    this.critical = critical; this.data = data.slice(); this.selected = false; this.enabled = false; this.writes = 0;
  }
  select(active) {
    if (active && this.selected) throw Error('Flash already selected');
    if (!active && [2, 32, 216].includes(this.command)) this.enabled = false;
    this.selected = active;
    if (active) { this.position = 0; this.address = 0; this.command = null; }
  }
  exchange(value) {
    if (!this.selected) throw Error('SPI flash clocked while deselected');
    let result = 255;
    if (this.position === 0) {
      this.critical?.command(value);
      if (![0, 2, 3, 4, 5, 6, 11, 32, 159, 216].includes(value)) throw Error(`Unmodeled flash command ${value}`);
      this.command = value; if (value === 6) this.enabled = true; if (value === 4) this.enabled = false;
    } else if ([2, 3, 11, 32, 216].includes(this.command) && this.position <= 3) {
      this.address = this.address * 256 + value;
      if (this.position === 3) {
        if (this.address >= this.data.length) throw Error('SPI address out of range');
        this.page = this.address & ~255;
        if ([32, 216].includes(this.command)) {
          
          const size = this.command === 32 ? 4096 : 65536, start = this.address & ~(size - 1);
          this.critical?.spi('erase', start, size);
          if (!this.enabled) throw Error('Erase without write enable');
          this.data.fill(255, start, start + size); this.writes++;
        }
      }
    } else if ([3, 11].includes(this.command)) {
      if (this.command !== 11 || this.position > 4) { result = this.data[this.address]; this.address = (this.address + 1) % this.data.length; }
    } else if (this.command === 2) {
      this.critical?.spi('program', this.address, 1, value);
      if (!this.enabled) throw Error('Programming without write enable');
      this.data[this.address] &= value; this.writes++; this.address = this.page | ((this.address + 1) & 255);
    } else if (this.command === 5) result = this.enabled ? 2 : 0;
    else if (this.command === 159) result = [239, 64, 24][(this.position - 1) % 3];
    this.position++; return result;
  }
}
