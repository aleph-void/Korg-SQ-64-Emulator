# Firmware bug examples for UI scripts

Two editable examples in **UI scripts → Example scripts** exercise text-handling paths where confirmed vendor defects were fixed in the reference version. Selecting **Load example** only loads the editor. Load firmware, disable debugging, load an example and choose Run script. Each example starts with Power on in normal mode and a 60-second startup wait, so it also works when the loaded virtual device is powered off. Power on resets an already running virtual device; save any session changes you want to keep first. Increase the startup wait if boot has not finished on your computer. To exercise an already booted session without resetting, remove the first two actions. These examples contain ordinary panel actions; they do not replace firmware, inject code or alter CPU registers.

| Example | What it exercises | Reference behavior |
| --- | --- | --- |
| **Regression exercise: GLOBAL channel label** | Repeated pad and encoder assignment rendering in Control mode, with channel set to GLOBAL | The channel label ends at `GLOBAL`; no uninitialized suffix is appended |
| **Regression exercise: short display labels** | Alternating Tempo and Swing popups through the UI text queue | Copy stops at the source NUL, retains at most 39 characters and zero-fills the rest of each 40-byte field |

Portable imports are [firmware-global-label.json](../web/examples/scripts/firmware-global-label.json) and [firmware-short-label-queue.json](../web/examples/scripts/firmware-short-label-queue.json). The dropdown and exports come from the same [template definitions](../web/emulator/bug-script-examples.js). Regenerate exports with `node tools/export_bug_script_examples.mjs`; `--check` detects drift.

## GLOBAL channel label

Use the default control mapping, or a mapping in which pads A1/A2 are momentary note controls and those controls plus PARAM1 use channel GLOBAL. The startup reset returns to the normal UI before the panel actions. The script selects Gate then Control mode, presses A1/A2 and alternates PARAM1 turns between pad presses. Each 1.5-second wait gives the transient popup time to expire and the assignment labels time to render. Control mode assigns MIDI actions to pads and encoders, as described in the [official owner's manual, page 18](https://cdn.korg.com/jp/support/download/files/306afb88f1e1ec63aeb9e072648f94d5.pdf).

The vendor formatter appended an uninitialized local suffix after the GLOBAL literal. The reference fix initializes that suffix to an empty string. Previous stack contents determine whether the vendor problem is visible: a clean-looking display on stock firmware is possible and is not evidence that the bug is absent. These actions exercise different rendering callers without artificially poisoning stack memory.

This example sends MIDI through the emulator's selected route and leaves Control mode active. Assignment changes are not part of the script. A custom mapping without GLOBAL channel assignments does not exercise this particular branch.

## Short display labels

The script stops playback, selects Gate mode and alternates small TEMPO/SWING turns in both directions. Observe the Tempo and Swing popups and continued response to input. It changes tempo/swing; inverse turns need not restore the original value at a clamp boundary. Use a disposable virtual session or preserve any values you want to keep.

The vendor producer copied forty bytes even when its source was a shorter NUL-terminated local string. This could copy unrelated stack bytes into the queue after the terminator. The reference fix bounds the copy and clears the tail. Visible text is deliberately preserved, so this memory-safety fix will often have no visible difference. To prove it, instrumentation must inspect both queue fields or run the guarded-source regression; counting a completed script or comparing screenshots is insufficient.

## Validation and scope

The public tests validate the templates, portable exports, script runner and existing session gates. Private validation ran the panel-action portions of these templates through the script runner and the real WebAssembly emulator against stock 2.03 and reference native56 2.04, starting from previously booted checkpoints. Read-only function hooks check GLOBAL rendering and queued text/tail behavior. Checkpoints, firmware bytes, function addresses and captured firmware data are not distributed with the examples. Public regression tests separately start both examples from a powered-off state and verify power-on precedes panel input and the startup delay is honored. Browser tests use synthetic firmware and shorten the startup wait. Neither test establishes boot readiness for arbitrary firmware, mappings or computer speeds.

The scripting format currently has no assertions, register/queue inspection, deterministic stack preparation, or firmware readiness condition. **Script complete means the actions completed**, not that the firmware passed a regression test. Waits use host milliseconds, so adjust them if the emulator runs slowly. The examples do not assert that stock will crash or display corruption. Existing critical monitoring remains enabled; a terminal warning cancels further actions and requires a fresh emulator session.

A third confirmed fix concerns lowest-octave sharp note labels: a four-byte local could overwrite a saved register when formatting a label requiring five bytes including NUL. Its reference regression covers every byte-valued note in both On/Off states. We did not label ordinary incoming MIDI notes as a reproducer: the affected path formats **Control-mode assignments**. A reliable UI example first needs suitable control mappings. The current script action permits 1024 MIDI bytes, while the full current-control SysEx message is 2349 bytes; the USB route requires a complete SysEx message, so splitting it into script actions is invalid. A future example can use an explicitly prepared mapping or a reviewed setup action that supports that complete transfer and verifies its response.
