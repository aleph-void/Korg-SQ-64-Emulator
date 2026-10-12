# SQ-64 emulator and device tools

An independent Aleph Void firmware workbench. The Vue 3 updater, backup/restore tool and WebAssembly emulator live together in **`web/`**. No server, account, upload service, native MIDI registration or vendor firmware is required for the browser emulator.

This is an **experimental board model**, not a hardware certification. The ARM CPU executes supplied firmware. The browser model connects all 64 pads, 21 other buttons, six encoders, LEDs and the display through modeled peripherals. Version and Update hold GLOBAL or GLOBAL+PATTERN at reset. USB enumeration, firmware installation and the panel paths have been exercised privately with stock 2.03 and custom 2.04. Analog outputs, electrical timing and arbitrary firmware remain outside that evidence. See [coverage and open work](docs/coverage.md).

## Run the browser app

```sh
cd web
npm ci
npm run dev
```

Open the printed localhost URL. Expand **Browser emulator**, load a caller-owned `.bin`, `.elf` or `.vsb`, run it, and choose **Connect browser emulator** in the updater. An original integration probe is available for a working updater/backup demonstration. It returns synthetic records and stages updates; **do not install it on hardware**.

For a physical device, select **Enable MIDI access**, grant SysEx permission, and select the SQ-64 sequencer input/output. Firmware transfer uses update mode; backup uses normal mode. Files stay in browser memory. Transfer acknowledgement does not prove programming completion; the UI asks for device confirmation. After restoring, use the power button and wait for shutdown before restarting and reading back. The browser workbench has a **Power off** button for this sequence. Its startup buttons reset immediately; closing the page discards the emulator session. Restore acknowledgement alone does not prove persistence.

## Test

```sh
cd web
npm test
npx playwright install chromium
npm run test:browser
npm run build
```

`npm test` covers package validation, transport failures, backup integrity, SPI semantics, CPU/IRQ execution, USB packetization, static export and a complete 224-packet transfer to executing original ARM code. Browser tests exercise the embedded worker, backup/restore, firmware staging and readback, boot chords, controls, mobile layout and local-only assets. `CHROMIUM_PATH` optionally selects an installed browser.

The Python implementation is also available for deterministic headless experiments:

```sh
python -m pip install -e .
python -m unittest discover -s tests -v
python -m sq64_emulator candidate.bin --headless --instructions 100000 --report run.json
```

The native GUI is optional (`python -m sq64_emulator`). OS MIDI is disabled unless `--midi` is explicitly selected. Browser operation is the cross-platform default. Native tests run on Linux here; CI includes macOS and Windows, whose results have not yet been observed. See [native engine notes](docs/coverage.md) for the required Unicorn IT-state patch on longer interrupt-heavy runs.

## Debug custom firmware

**Validate Image** in either workbench runs the seven automated checks from the [SQ-64 conformance spec](https://github.com/aleph-void/Korg-SQ-64-Custom-Firmware-Spec/tree/a71297981a601b5e69e5d44dc44ada897050df3d) v0.2.0, `image` profile, locally. The results show each requirement, the exact loaded file's SHA-256, and the pinned spec revision. **Save validation report** downloads the results; execution and debug reports include them too. Unless a critical damage detector passes, validation preserves execution state, breakpoints, registers and trace, including when stopped at a breakpoint or fault.

The profile requires a complete VSB package. BIN and ELF files remain runnable/debuggable but fail package geometry, with dependent checks marked not-run. Results concern the original loaded file, retained across reset; they do not validate subsequent runtime writes or installed updates. Loading another file clears the report. Software and hardware profiles need separate execution evidence and are not claimed by this button.

Critical damage detectors use `severity: "critical"` and `unsafeWhen: "pass"` on their result rows. A result with both fields and `status: "pass"` immediately terminates execution and MIDI in either workbench, blocks further execution, resets and loads for that session, and displays **Do not flash this firmware to a real device**. Validation shows **UNSAFE** even if the evaluator's overall status is `pass`; reports retain the original results, triggering test IDs and image hash. Reports remain downloadable after termination. Start a new browser session (reload the containing page) or restart the native workbench to investigate another image. This guard is always enabled; there is no UI bypass.

When updating the pinned spec, place these fields on the corresponding catalog requirements as well: `tools/sync_conformance.py` preserves them for the browser, and both evaluator adapters copy them onto result rows. The current v0.2.0 image profile contains no damage detectors. Adding metadata does not implement a test: new checks still need evaluator implementations and parity tests. Validation runs when **Validate Image** is selected; this integration does not yet run continuous hardware-behavior checks.

Load your image, expand **Developer debugging**, and select **Enable debugging** in either workbench. This pauses execution and exposes single-instruction stepping, address breakpoints, CPU registers, code/RAM inspection, and a bounded instruction trace. **Run** continues past the current breakpoint once; **Power on** resets and stays paused while debugging is enabled. **Save debug report** exports registers and the trace alongside the image hash, fault details, and peripheral/interrupt reports. Debugging is disabled by default and can be turned off to restore normal execution speed.

The native CLI also supports reproducible debug reports:

```sh
python -m sq64_emulator candidate.elf --headless --debug \
  --breakpoint 0x00200008 --trace-limit 256 \
  --inspect 0x20000000:128 --instructions 100000 --report debug.json
```

Use addresses from your firmware's linker map or disassembly; the example breakpoint is only illustrative. Repeat `--breakpoint` (up to 64 addresses) and `--inspect` (1–4096 bytes per range) for additional locations. Traces keep the last 256 instruction hook entries by default; `--trace-limit 0` disables tracing and 4096 is the maximum. A breakpoint ends the headless run successfully; faults retain diagnostics and exit with status 1. Without `--headless`, `--debug` and its breakpoint/trace settings initialize the native GUI, including subsequently loaded images.

Memory inspection never invokes peripheral reads. Traces record PC/opcode bytes before execution, so a faulting or preempted instruction can appear without completing. Debugging uses instruction boundaries rather than source lines; symbol loading, watchpoints, and GDB remote connections are not implemented. See the [browser debugger notes](web/README.md#debugging-firmware) for reset, loading and MIDI behavior.

## Publish only the web app

The future domain is `sq64.alephvoid.com`. [Deployment instructions](web/README.md) export only web runtime files into a directory suitable for the **root of a Pages deployment branch**. The browser image validator and its license are included; native sources and the full spec project are not deployed. Nothing is pushed or published by the build command.

## Source policy

No original Korg firmware, decompiled code or vendor assets are included. Host implementations and diagnostic ARM programs are independently authored from interface facts. This is not a claim of legally certified clean-room development. Read [PROVENANCE.md](PROVENANCE.md). Unicorn/unicorn.js are GPLv2; their complete corresponding source and build recipe are shipped with the web app. See LICENSE and web/NOTICE.txt.

## License

The emulator, integrated web tools, and original diagnostic probes are licensed under **GNU GPL version 2 only** (`GPL-2.0-only`); see [LICENSE](LICENSE). You may use, modify, and redistribute them under those terms. They are provided without warranty.

Redistributed native builds and hosted browser builds must provide their corresponding source, modifications, and build scripts under GPLv2. The browser distribution includes the patched Unicorn engine's complete corresponding source and build recipe in `web/vendor/`. Keep the source for each released application version available alongside that release. Upstream copyright notices and third-party licenses remain in force; fonts retain their OFL licenses, and the license grants no trademark rights. Firmware supplied by a user is separate from the emulator's license.
