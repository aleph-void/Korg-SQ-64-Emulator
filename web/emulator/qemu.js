// Browser-local QEMU transport. Native CPU/device ownership is shared with the
// command-line board; JavaScript only submits requests and presents results.
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
export const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
export function unhex(text) {
  if (typeof text !== 'string' || text.length % 2 || !/^[\da-f]*$/i.test(text)) throw Error('Invalid native byte string');
  return Uint8Array.from(text.match(/../g) || [], byte => parseInt(byte, 16));
}
export function imageElf(image) {
  const offset = 52 + image.segments.length * 32;
  const size = offset + image.segments.reduce((n, segment) => n + ((segment.data.length + 3) & ~3), 0);
  const out = new Uint8Array(size), view = new DataView(out.buffer);
  out.set([127, 69, 76, 70, 1, 1, 1]);
  view.setUint16(16, 2, true); view.setUint16(18, 40, true); view.setUint32(20, 1, true);
  view.setUint32(24, image.reset, true); view.setUint32(28, 52, true); view.setUint32(36, 0x05000000, true);
  view.setUint16(40, 52, true); view.setUint16(42, 32, true); view.setUint16(44, image.segments.length, true);
  let at = offset;
  image.segments.forEach((segment, index) => {
    const values = [1, at, segment.address, segment.address, segment.data.length, segment.data.length, 7, 4];
    values.forEach((value, column) => view.setUint32(52 + index * 32 + column * 4, value, true));
    out.set(segment.data, at); at += (segment.data.length + 3) & ~3;
  });
  return out;
}
export class Qemu {
  static async create(image, {factory, seconds = 120} = {}) {
    if (!factory) factory = (await import('../vendor/qemu/qemu-system-arm.js')).default;
    if (typeof SharedArrayBuffer === 'undefined' || typeof window !== 'undefined' && !globalThis.crossOriginIsolated)
      throw Error('The local QEMU runtime requires cross-origin isolation for its native worker threads');
    const elf = imageElf(image), spi = new Uint8Array(0x1000000).fill(255);
    if (![0x100000, 0x1000000].includes(image.spi.length)) throw Error('Unsupported source SPI geometry');
    spi.set(image.spi);
    const diagnostics = [];
    const module = await factory({
      arguments: ['-M', 'sq64,spi-state=/spi.bin', '-kernel', '/firmware.elf', '-S',
        '-accel', 'tcg,thread=single,tb-size=16', '-icount', 'shift=0,sleep=off',
        '-display', 'none', '-monitor', 'none', '-serial', 'none', '-nodefaults'],
      preRun: [module => { module.FS.writeFile('/firmware.elf', elf); module.FS.writeFile('/spi.bin', spi); }],
      print: text => { diagnostics.push(String(text)); if (diagnostics.length > 128) diagnostics.shift(); },
      printErr: text => { diagnostics.push(String(text)); if (diagnostics.length > 128) diagnostics.shift(); },
    });
    const runtime = new Qemu(module, diagnostics);
    try {
      const deadline = performance.now() + seconds * 1000;
      while (!module._sq64_web_ready()) {
        if (performance.now() >= deadline) throw Error('Native QEMU initialization timed out: ' + diagnostics.join('\n'));
        await delay(1);
      }
      await runtime.request({operation: 'state'}); return runtime;
    } catch (error) { runtime.close(); throw error; }
  }
  constructor(module, diagnostics) {
    this.module = module; this.diagnostics = diagnostics; this.closed = false; this.sequence = Promise.resolve();
  }
  request(value, seconds = 120) {
    const operation = this.sequence.then(async () => {
      if (this.closed) throw Error('Native QEMU session is closed');
      const m = this.module, encoded = new TextEncoder().encode(JSON.stringify(value) + '\0');
      const pointer = m._malloc(encoded.length);
      if (!pointer) throw Error('Native request allocation failed');
      try {
        m.HEAPU8.set(encoded, pointer);
        if (!m._sq64_web_submit(pointer)) throw Error('Native command mailbox is busy');
      } finally { m._free(pointer); }
      const deadline = performance.now() + seconds * 1000;
      for (;;) {
        if (this.closed) throw Error('Native QEMU session is closed');
        const result = m._sq64_web_take();
        if (result) {
          let parsed;
          try { parsed = JSON.parse(m.UTF8ToString(result)); } finally { m._free(result); }
          if (parsed.error) throw Error(parsed.error);
          return parsed;
        }
        if (performance.now() >= deadline) { this.close(); throw Error('Native QEMU command timed out'); }
        await delay(0);
      }
    });
    this.sequence = operation.catch(() => {}); return operation;
  }
  close() {
    if (!this.closed) {
      this.closed = true;
      this.module.PThread.terminateAllThreads();
    }
  }
}
