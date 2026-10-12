# Browser model coverage

The browser engine executes supplied ARM Thumb firmware with Unicorn's Cortex-M7 CPU model. Private stock 2.03 and caller-owned custom native56 2.04 checks now pass USB startup, panel input, both update directions, and backup/restore across normal shutdown and cold restart. Firmware images, decoded displays, checkpoints, and populated backups stay outside the public projects. These are bounded software compatibility results, not hardware certification.

| Area | Implemented and exercised | Remaining evidence |
| --- | --- | --- |
| CPU | Cortex-M7 execution, integer/FPU exception frames, MSP/PSP, interrupt masks/priorities, IT-state handling, alignment guards | Wider interrupt/FP schedules and faults |
| Memory | Flash aliases, SRAM, ELF/VSB loaders, installed-flash restart | Full board protection and reserved-region ownership |
| SPI NOR | 16 MiB, page programming, NOR bit clearing, erase, populated saved slots 0 and 63 | Physical part identity, real busy timing, protected/calibration ranges |
| USB | Cold enumeration, identity, sequencer cable routing, real update/backup traffic | Electrical behavior, complete controller semantics and timing |
| Panel | All 85 buttons, six quadrature encoders, firmware-driven LED scans, Version/Update boot chords | Independent physical wiring captures and electrical timing |
| LEDs/display | Continuous LED brightness from firmware PWM samples, including named transport controls; readable 256×64 display DMA output | Hardware LED colors/brightness and complete display-controller commands |
| Power | Active-low power-button input and firmware-controlled power-hold output | Electrical power-loss behavior |
| Update | Both stock→custom and custom→stock; all 224 packets, exact installed internal/SPI code bytes, Version-screen reboot | Physical-device browser trials and interrupted programming |
| Backup/restore | Current project plus populated first/last saved slots; melody and rhythm; exact 95-record readback after normal shutdown and cold restart | Wider edited-pattern fixtures, concurrent performance, arbitrary candidates |
| CV/gate/sync | Requirements recorded in the sibling spec; no jack-voltage visualization | Output circuitry/pin model, calibrated voltages, timing captures |

Unknown peripheral accesses stop execution where the model can identify them. Known configuration registers can use passive backing storage; the execution report lists this approximation because it can conceal incomplete peripheral behavior. Virtual time defaults to 16 nominal cycles per instruction and is not cycle accurate. Panel DMA spacing follows the configured APB2 and SPI divisors. PA9 supplies virtual host VBUS; GPIO C13 supplies the power button and B7 controls power hold. PB4 defaults high for an unplugged sync jack, allowing internal clock operation. Timer clocks honor APB divisors and TIMPRE. Parameter encoder quadrature pairs follow the four display columns. Interactive buttons retain each edge for at least 40 ms of virtual time so short browser clicks survive firmware debounce; raw input/replay timing remains explicit. No host patch replaces application code or writes its runtime state to make compatibility checks pass.

## Private firmware acceptance — 2026-10-11

Google Chrome 155 on Linux exercised the embedded workbench with physical Web MIDI access prohibited. Both supplied images passed cold USB startup and identity, visible firmware response to GUI controls, backup and restore, Version and Update entry, complete installation of the other image, installed-code byte comparison, and Version-screen restart. Both versions were read visually from the resulting displays.

A separate populated-data check imported a private 95-record archive through the GUI, used **Power off**, waited for the firmware to release power hold, performed a full cold normal restart, and downloaded an identical all-content backup. The archive includes a current project and saved slots 0 and 63, each with melody and rhythm data. Private direct-WASM checks also changed the current project before restoring it and verified every restored record before and after shutdown. All 85 button press/release paths and both directions of all six encoders were independently observed at the executing firmware's input dispatch.

Restore acknowledgement alone is insufficient. An abrupt reset lost catalog/current-workspace metadata in the private checks, even though saved project payloads remained in SPI. Use normal power-button shutdown before testing persistence. Power on, Version and Update reset immediately. Closing/reloading the page discards the in-memory emulator session; download a backup to retain data outside it.

Public regressions contain only independently authored fixtures: 44 core tests and 11 Chrome tests cover protocol handling, malformed data, transport failures, panel scans, USB registers, NOR capacity, CPU/IRQ execution, firmware-driven power-off, GUI operations, mobile layout, and branch-ready static export. The original ARM integration probe uses modeled DIN registers, synthetic backup data, and update staging; it does not itself establish installed firmware or real-device compatibility. The private supplied-image tests establish the bounded results above.

## Native engine

The Python backend remains a separate, less complete model; the browser compatibility results do not extend to it. It pins Unicorn 2.1.3, whose upstream instruction hook can expose stale IT state during interrupt injection. The correction is in `tools/unicorn-2.1.3-itstate.patch`; interrupt-heavy native runs require a patched source build and `LIBUNICORN_PATH`. The bundled WASM engine uses pinned Unicorn 2.1.4 with that correction applied. Linux browser checks do not establish observed macOS/Windows results, although the browser runtime is portable and native CI includes those systems.

## Further verification

1. Confirm panel wiring, LED color channels, and display commands with independent physical captures.
2. Compare USB descriptors, FIFO traffic and endpoint timing against hardware.
3. Establish reserved storage ownership and calibrated CV/gate/sync behavior before hardware conformance claims.
4. Expand original diagnostic firmware and supplied-candidate tests for faults, scheduling, edited patterns and installation interruption.

## Browser execution performance

Memory access uses current WebAssembly heap views with mapped-region bounds checks. Timer counters advance lazily at register accesses and scheduled overflows; interrupt delivery remains at the same instruction boundary. Panel wiring tables are prepared once. The worker runs short batches within a 12 ms time slice before yielding for input. These changes do not increase virtual time per instruction or skip firmware code.

Private stock/custom comparisons after three million instructions matched all mapped memory, registers, SPI, IRQ traces, display, LEDs and MIDI. Normal-mode samples were 5.5–6.3 times faster, and update-mode samples 2.6–2.7 times faster, on the test host. Optimized Chrome cold boots reached the first frame at about four seconds and USB configuration at 56–57 seconds. Performance depends on the host and firmware; the model is still slower than the physical device.


The next optimization adds an original C bridge to the WASM engine. It filters ordinary RAM accesses and batches elapsed instruction accounting, retaining JavaScript callbacks at peripheral accesses, timer/service deadlines, queued input edges, IT instructions, and eligible interrupt boundaries. It does not replace firmware routines. A scalar execution option remains available for differential testing. Full stock cold boot matched scalar CPU registers, memory and interrupt state at each million-instruction boundary through USB configuration. The worker now yields with MessageChannel to avoid the nested browser timer clamp and refreshes visible state every 50 ms. Parameter knobs 1/2 and 3/4 have corrected wiring; control LEDs and pad PWM brightness now have distinct visible intensities.


Release 0.1.1 was checked in Chrome 155 on Linux with private stock 2.03 and custom 2.04 images: first display appeared at 2.4–2.5 seconds and USB configured at 26–27 seconds, versus the previous 56–57 seconds. All six knobs changed the firmware framebuffer, a short A1 click changed its PWM level from 12 to 195, PLAY lit and the cursor advanced, and TAP alternated between 0 and 255. The public 44-test core and 11-test Chrome suites passed, including original-probe backup/restore and all 224 update packets. Top-edge CV/output visualization is still pending; this release makes no additional analog-output claim.
