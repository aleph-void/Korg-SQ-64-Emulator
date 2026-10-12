// Original panel action sequences. No firmware, private addresses or saved data.
// These exercise confirmed defects; script completion is not a regression verdict.
const press = control => ({ type: 'press', control, ms: 150 });
const wait = ms => ({ type: 'wait', ms });
const startup = () => [{ type: 'power-on', mode: 'normal' }, wait(60000)];
const turn = (control, delta) => ({ type: 'encoder', control, delta });

export const BUG_SCRIPT_EXAMPLES = [
  {
    id: 'firmware-global-label',
    description: 'Power on with normal boot and wait 60 seconds. Requires the default control mapping (channel GLOBAL). Repeatedly display pad and encoder assignments. The reference fix keeps GLOBAL free of stray suffix characters; stock may also look normal depending on prior stack contents. Sends virtual MIDI; leaves Control mode active.',
    script: { name: 'Regression exercise: GLOBAL channel label', actions: [
      ...startup(), press('stop'), press('gate'), press('control'),
      press('A1'), wait(1500), press('A2'), wait(1500),
      turn('param1', 1), wait(1500), press('A1'), wait(1500),
      turn('param1', -1), wait(1500), press('A2'), wait(1500),
    ] },
  },
  {
    id: 'firmware-short-label-queue',
    description: 'Power on with normal boot and wait 60 seconds. Alternate TEMPO and SWING popups to exercise short text queued for display. The reference fix preserves text and clears unused queue bytes. The stock over-read can be invisible; this script alone cannot inspect it. Changes tempo/swing and leaves Gate mode active.',
    script: { name: 'Regression exercise: short display labels', actions: [
      ...startup(), press('stop'), press('gate'), wait(750),
      turn('tempo', 1), wait(750), turn('swing', 1), wait(750),
      turn('tempo', -1), wait(750), turn('swing', -1), wait(750),
      turn('tempo', 1), wait(750), turn('swing', -1), wait(750),
      turn('tempo', -1), wait(750), turn('swing', 1), wait(1500),
    ] },
  },
];
