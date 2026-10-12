import { transferPlan } from '../src/protocol.js';

const equal = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);

// A host-requested installation is allowed to replace only the selected image's
// firmware regions, with that image's exact bytes. Merely booting update mode
// does not grant permission. All packets must have been submitted in order.
export class FirmwareInstallation {
  constructor(pkg, caps, imageSha256) {
    this.payload = Uint8Array.from(pkg.payload);
    this.internalView = new DataView(this.payload.buffer);
    this.plan = transferPlan({ ...pkg, payload: this.payload }, caps, [0, 0], true);
    this.imageSha256 = imageSha256;
    this.phase = 'prepared';
    this.packets = 0;
    this.mutationAttempted = false;
    this.spi = new Uint8Array(0x30000).fill(255);
    for (const [source, target, length] of [[0x10000, 0, 0x4000], [0x34000, 0x4000, 0x4000], [0x14000, 0x10000, 0x20000]])
      this.spi.set(this.payload.subarray(source, source + length), target);
  }
  receive(data) {
    if (this.phase === 'prepared' && equal(data, this.plan.begin)) this.phase = 'receiving';
    else if (this.phase === 'receiving' && equal(data, this.plan.packet(this.packets))) {
      if (++this.packets === this.plan.count) this.phase = 'installing';
    } else this.phase = 'cancelled';
  }
  cancel() {
    // Once the last packet was submitted the firmware can already be writing.
    // Stopping the host cannot undo it; retain only this exact image's scope.
    if (this.phase !== 'installing') this.phase = 'cancelled';
  }
  allow(allowed) {
    if (this.phase !== 'installing' || !allowed) return false;
    this.mutationAttempted = true;
    return true;
  }
  internal(address, length, value, source) {
    const offset = address - 0x08000000;
    return this.allow(source === 'cpu' && length === 4 && offset >= 0 && offset + length <= 0x10000 && !(offset & 3) &&
      value === this.internalView.getUint32(offset, true));
  }
  erase(address, length, value, source) {
    return this.allow(source === 'cpu' && address === 0x40023c10 && length === 4 && value !== undefined &&
      !(value & 4) && (value >>> 3 & 15) < 4);
  }
  spiWrite(operation, address, length, value) {
    return this.allow(address >= 0 && address + length <= this.spi.length &&
      (operation === 'erase' && [4096, 65536].includes(length) && address % length === 0 ||
       operation === 'program' && length === 1 && value === this.spi[address]));
  }
  report() {
    return { policy: 'selected-update-image', phase: this.phase, imageSha256: this.imageSha256,
      packetsSubmitted: this.packets, totalPackets: this.plan.count, mutationAttempted: this.mutationAttempted };
  }
}
