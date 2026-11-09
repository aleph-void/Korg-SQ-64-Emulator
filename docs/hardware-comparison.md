# Real-device comparison

The emulator has now been checked against a real SQ-64. A community user developed a modification of stock 2.03 (per-pattern Bank Select + Program Change on tracks A–C) almost entirely in the browser emulator, then flashed it to their own device. The report is in [aleph-void/Korg-SQ-64-Emulator#1](https://github.com/aleph-void/Korg-SQ-64-Emulator/issues/1). Everything below is that user's observation on one device. It is not a hardware certification, and it does not extend to arbitrary firmware.

## Behavior that matched the emulator

- **Update mode** (GLOBAL + PATTERN at power-on): downgrading from 2.04 to stock 2.03 with the official updater, then flashing several modified images back and forth. Saved projects survived each update.
- **Version screen** (GLOBAL at power-on), including a line added by the modified firmware.
- **Panel controls** that were used: buttons, pads and encoders, the GLOBAL pages, and the project save/load dialogs.
- **Global settings** are saved on leaving GLOBAL and survive a power cycle.
- **Project save and load.** A save-related issue first seen on the device was reproduced and its fix confirmed in the emulator by reading the project slot back from emulated flash.
- **USB MIDI output**, checked with a MIDI monitor: the messages and their order matched the emulator.
- **DIN MIDI output** and **external clock start** also worked on the device. The emulator UI does not show DIN output, so these were confirmed only on hardware.

## Known differences

| Area | Real device | Browser emulator |
| --- | --- | --- |
| Cold boot | Seconds | Reported at about three minutes in the user's browser, against about 27 seconds for USB configuration on the project's test host. Speed depends on host and browser. See [startup performance](browser-startup-performance.md). |
| Background operation | Always runs | Execution pauses or slows a lot while the tab is hidden, because browsers throttle background tabs. Keep the tab visible for timing-sensitive work, transfers and scripts. |
| DIN MIDI | 5-pin output | Not visible in the emulator UI with this firmware; use USB MIDI output for comparisons. |

Analog CV/gate/sync voltages, electrical timing, and interrupted-update recovery were not part of this comparison and are still unverified. See [coverage](coverage.md).

## Official updater notes (`kmupdate.exe` 2.03, Windows)

The same user ran into some quirks in Korg's official Windows updater. None of them come from this project, but they can lead to the wrong image being flashed:

- After **File → Open**, the updater may stop detecting a device that is already in update mode. Start the updater with the device already in update mode and do not use File → Open, or restart the updater.
- The updater silently uses the `.vsb` in its own folder. Keep **exactly one** image in each updater folder.
- **Skip Version Check** is not remembered between runs. Set it again each time you downgrade or reinstall.
- Launching the updater from Windows' recent-files list once started an older copy from a different folder, which then flashed the old image. Start the updater from the folder that holds the intended image, and check the version on the device's Version screen afterwards.

The browser updater in **Device tools** avoids the folder ambiguity, because it only sends the file you select explicitly. The real-device report above used the official Windows updater, not this project's browser updater; browser-to-hardware transfers still need independent confirmation.
