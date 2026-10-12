// Board output interfaces, independent of firmware addresses or application RAM.
// Levels are visual activity estimates, not calibrated jack voltages.
export const OUTPUT_GROUPS = [
  ...[...'ABC'].map(track => ({label: track, outputs: ['mod', 'pitch', 'gate'].map(kind => ({id: track + kind, label: kind.toUpperCase(), name: `Track ${track} ${kind} output`}))})),
  {label: 'D · TRIG', outputs: Array.from({length: 8}, (_, i) => ({id: `D${i + 1}`, label: String(i + 1), name: `Track D trigger ${i + 1} output`}))}
];
const GATES = [[0x40020400, 12], [0x40020400, 15], [0x40020800, 9]];

export function outputLevels(board) {
  const levels = Object.fromEntries(OUTPUT_GROUPS.flatMap(group => group.outputs.map(({id}) => [id, 0])));
  if (board.poweredOff) return levels;
  const get = address => board.get(address);
  for (let i = 0; i < GATES.length; i++) {
    const [port, pin] = GATES[i];
    // Gate drivers invert the MCU output; ignore pins not configured as outputs.
    if ((get(port) >>> (pin * 2) & 3) === 1) levels['ABC'[i] + 'gate'] = get(port + 20) & (1 << pin) ? 0 : 255;
  }
  for (let i = 0; i < 8; i++) levels[`D${i + 1}`] = board.panel.triggers & (1 << i) ? 255 : 0;

  // SAI1 block B streams eight 24-bit slots through DMA2 stream 6. Observe
  // only an enabled, circular, incrementing word transfer in mapped SRAM.
  const dma = 0x400264a0, control = get(dma), sai = get(0x40015c24), source = get(dma + 12);
  // Check channel/direction/width/addressing, without depending on DMA priority.
  const valid = (control & 0x0e047fc1) === 0x06005541 && get(dma + 8) === 0x40015c40
    && get(dma + 4) === 8 && (sai & 0x300e3) === 0x300c0
    && source % 4 === 0 && source >= 0x20000000 && source + 32 <= 0x20040000;
  if (valid) for (let slot = 0; slot < 6; slot++) {
    const sample = get(source + slot * 4) << 8 >> 8; // signed 24-bit DAC sample
    const level = Math.max(0, Math.min(255, Math.round((0x7fffff - sample) * 255 / 0xfffffe)));
    levels['ABC'[slot >> 1] + (slot % 2 ? 'pitch' : 'mod')] = level;
  }
  return levels;
}
