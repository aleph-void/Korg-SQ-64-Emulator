import { SCRIPT_FORMAT } from './scripts.js';

// Templates only: choosing one never runs it or changes the saved library.
export const SCRIPT_EXAMPLES = [
  {
    id: 'transport', description: 'Start normally, allow 60 seconds for boot, then press PLAY and STOP. Leaves power on.',
    script: { name: 'Start, play, and stop', actions: [
      { type: 'power-on', mode: 'normal' }, { type: 'wait', ms: 60000 },
      { type: 'press', control: 'play', ms: 150 }, { type: 'wait', ms: 2000 },
      { type: 'press', control: 'stop', ms: 150 },
    ] },
  },
  {
    id: 'hold', description: 'On an already booted instance, hold SHIFT while pressing pad A1, then release SHIFT. May edit the current pattern.',
    script: { name: 'Hold SHIFT and press a pad', actions: [
      { type: 'button', control: 'shift', down: true },
      { type: 'press', control: 'A1', ms: 250 },
      { type: 'button', control: 'shift', down: false },
    ] },
  },
  {
    id: 'encoders', description: 'On an already booted instance, turn TEMPO and PARAM1 in both directions. Watch the firmware display for values.',
    script: { name: 'Turn the encoders', actions: [
      { type: 'encoder', control: 'tempo', delta: 4 }, { type: 'wait', ms: 1000 },
      { type: 'encoder', control: 'tempo', delta: -4 },
      { type: 'encoder', control: 'param1', delta: 2 }, { type: 'wait', ms: 1000 },
      { type: 'encoder', control: 'param1', delta: -2 },
    ] },
  },
  {
    id: 'version', description: 'Power on with GLOBAL held, wait 60 seconds, and release GLOBAL. Leaves the instance powered on.',
    script: { name: 'Version mode startup', actions: [
      { type: 'power-on', mode: 'version' }, { type: 'wait', ms: 60000 },
      { type: 'button', control: 'global', down: false },
    ] },
  },
  {
    id: 'shutdown', description: 'Start normally, wait 60 seconds, then explicitly power off and wait for firmware shutdown.',
    script: { name: 'Start and power off', actions: [
      { type: 'power-on', mode: 'normal' }, { type: 'wait', ms: 60000 }, { type: 'power-off' },
    ] },
  },
].map(example => ({ ...example, script: { format: SCRIPT_FORMAT, version: 1, ...example.script } }));
