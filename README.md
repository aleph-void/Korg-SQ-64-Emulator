# SQ-64 emulator and device tools

An independent Aleph Void firmware workbench. The client-only updater, backup/restore tool and WebAssembly emulator live together in **`web/`**. No server, account, upload service, native MIDI registration or vendor firmware is required for the browser emulator.

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

## Publish only the web app

The future domain is `sq64.alephvoid.com`. [Deployment instructions](web/README.md) export only web runtime files into a directory suitable for the **root of a Pages deployment branch**. Native sources and the spec are not deployed. Nothing is pushed or published by the build command.

## Source policy

No original Korg firmware, decompiled code or vendor assets are included. Host implementations and diagnostic ARM programs are independently authored from interface facts. This is not a claim of legally certified clean-room development. Read [PROVENANCE.md](PROVENANCE.md). Unicorn/unicorn.js are GPLv2; their complete corresponding source and build recipe are shipped with the web app. See LICENSE and web/NOTICE.txt.

## License

The emulator, integrated web tools, and original diagnostic probes are licensed under **GNU GPL version 2 only** (`GPL-2.0-only`); see [LICENSE](LICENSE). You may use, modify, and redistribute them under those terms. They are provided without warranty.

Redistributed native builds and hosted browser builds must provide their corresponding source, modifications, and build scripts under GPLv2. The browser distribution includes the patched Unicorn engine's complete corresponding source and build recipe in `web/vendor/`. Keep the source for each released application version available alongside that release. Upstream copyright notices and third-party licenses remain in force; fonts retain their OFL licenses, and the license grants no trademark rights. Firmware supplied by a user is separate from the emulator's license.
