// Accumulate physical distance instead of counting browser event packets.
export class KnobMotion {
  constructor() { this.reset(); }
  reset() { this.remainder = 0; this.source = null; this.fine = false; }
  move(distance, pixelsPerStep, source, fine = false) {
    if (source !== this.source || fine !== this.fine || distance * this.remainder < 0) this.remainder = 0;
    this.source = source; this.fine = fine;
    this.remainder += distance / (pixelsPerStep * (fine ? 4 : 1));
    const steps = Math.trunc(this.remainder + Math.sign(this.remainder) * 1e-9);
    this.remainder -= steps;
    if (Math.abs(this.remainder) < 1e-9) this.remainder = 0;
    return Math.max(-128, Math.min(128, steps));
  }
  wheel(event) {
    const pixels = -event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 120 : 1);
    return this.move(pixels, 40, 'wheel', event.shiftKey);
  }
  drag(distance, fine) { return this.move(distance, 12, 'drag', fine); }
}
