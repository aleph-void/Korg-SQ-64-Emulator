// The captured framebuffer stores two grayscale pixels per byte, with the
// left pixel in the low nibble. Captured rows run from bottom to top for the
// observed panel orientation; programmable controller remapping is not modeled.
export function displayPixels(frame) {
  if (frame.length !== 8192) throw Error('Unsupported display frame');
  const pixels = new Uint8ClampedArray(256 * 64 * 4);
  for (let i = 0; i < 256 * 64; i++) {
    const x = i % 256, y = Math.floor(i / 256);
    const pair = frame[(63 - y) * 128 + (x >> 1)];
    const value = ((i & 1) ? pair >> 4 : pair & 15) * 17;
    pixels.set([value * .83, value * .9, value, 255], i * 4);
  }
  return pixels;
}
