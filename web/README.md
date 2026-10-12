# Aleph Void SQ-64 web app

The updater and browser emulator use Vue 3 single-file components, compiled by Vite. Use Node 20.19+ or 22.12+ and install dependencies before developing or building. Serve the built `dist/` directory over HTTPS or localhost; opening `index.html` as a `file:` URL does not support module workers. The embedded emulator communicates directly with the updater using in-process MIDI-style ports. It neither requests Web MIDI permission nor creates an operating-system MIDI device. Real hardware uses Web MIDI with SysEx permission.

```sh
npm ci
npm run dev
npm test
npm run test:browser
npm run build
npm run preview
```

`npm run dev` serves the Vue sources with hot reload. `npm run preview` serves the most recent static build. Both default to http://127.0.0.1:4173. The production export bundles Vue and the emulator worker locally, precompiles templates, and retains the content security policy without JavaScript `unsafe-eval`. The main page and `emulator/index.html` are separate entry points. Browser tests run against the production export, including a nested URL path. The optional Python workbench has its own UI in `sq64_emulator/ui/`.

## Emulator shutdown and saved data

Use **Power off** and wait for **Powered off** before restarting after a restore. Firmware saves the current workspace and project catalog during this shutdown. **Power on**, **Version mode** and **Update mode** reset immediately. Closing or reloading the page discards the session, including its emulated flash; retain a downloaded backup outside the browser.

The panel shows firmware-driven LED brightness and display output, with updates paced near 60 Hz and painted on browser animation frames. Execution batches adapt to host speed to keep input responsive; emulated time still depends on instruction throughput. Its top edge includes MOD, PITCH and GATE indicators for tracks A–C and eight trigger indicators for track D. These follow the CV stream, gate pins and trigger latch, using the Aleph Void accent color. Brightness is a relative activity estimate; calibrated jack voltages and CV/gate/sync traces are not implemented.

During normal execution, pad brightness transitions take 120 ms to soften coarse PWM steps and brief dark samples in startup animations. Pressed pads, paused or faulted execution, and debugging show changes immediately. Reduced-motion preferences disable the transitions. Reported LED values and emulated timing are unchanged.

Turn knobs with a vertical drag, the scroll wheel, or the arrow keys. Wheel and drag distance determine the number of steps; tiny trackpad events accumulate. Hold Shift while dragging or scrolling for four times finer adjustment. Arrow keys produce one step. Interactive steps are spaced in virtual time to avoid unintended firmware acceleration when the browser runs slower than the device.

These are relative encoders. Their angle shows accumulated input steps, not the firmware's parameter value: noon is not zero, and turning back to noon does not reset a value. Firmware can clamp or wrap a parameter independently of the angle. Read the value on the firmware display. Partial gestures clear when loading/resetting the emulator, locking controls, leaving the knob, or switching to arrow-key input.

Selecting a valid firmware image enables **Power on** without starting execution. Loading status and errors appear beside the file picker and in the execution section; a failed replacement keeps the previously loaded image available. The file picker permits selecting the same file again after an error.

## UI scripts

Expand **UI scripts** below the instrument panel. Choose one of five **Example scripts** and click **Load example**, or start a **New script**. Examples cover transport buttons, a SHIFT/pad combination, encoder turns, version-mode startup, and explicit shutdown. They load editable templates without executing them. Adjust startup waits for your firmware and computer.

Use **Append action** to build a sequence, or edit/reorder/remove entries in the actions JSON editor. **Run script** executes the editor contents against the loaded firmware and shows progress. Buttons, encoder positions, firmware display, and LEDs update during execution through the normal emulator input path. Manual controls, debugger changes, image replacement, and updater/backup operations are locked during playback. Disable debugging before running a script.

**The instance keeps running when a script finishes unless the script explicitly powers it off.** A script resumes paused execution; include Power on to reset or restart a powered-off instance. Power on supports normal, version (GLOBAL held), and update (GLOBAL + PATTERN held) modes. Release startup buttons with `button` actions whose `down` is `false`. Power off holds the emulated power button and waits for firmware shutdown; firmware that does not respond produces an error after two minutes. It does not forcibly discard the instance.

**Stop script** cancels remaining actions and leaves the emulator in its current state. An interrupted timed press is released; explicit held buttons remain held until released. A power-off already sent to firmware continues its shutdown. Faults stop playback and are reported without executing the remaining actions.

**Save in browser** stores the named script in IndexedDB. Select it from **Saved scripts** to edit or overwrite it; **New script** starts a separate entry. **Delete saved script** removes the browser copy while retaining its contents in the editor. Storage survives reloads and is shared by standalone and embedded workbenches on the same origin. Firmware and emulated flash are not stored with scripts. Clearing browser site data removes the library. **Export script** downloads a JSON copy, and **Import script** validates a file and opens it as an unsaved draft. Neither import nor selecting a saved script runs it. Import/export remain available when browser storage is unavailable.

The portable format is versioned JSON data, not JavaScript. For example:

```json
{
  "format": "sq64-ui-script",
  "version": 1,
  "name": "Play and stop",
  "actions": [
    { "type": "power-on", "mode": "normal" },
    { "type": "wait", "ms": 60000 },
    { "type": "press", "control": "play", "ms": 150 },
    { "type": "wait", "ms": 2000 },
    { "type": "press", "control": "stop", "ms": 150 }
  ]
}
```

| Action | Fields | Behavior |
| --- | --- | --- |
| `power-on` | `mode`: `normal`, `version`, or `update` | Reset and start with the selected startup buttons held. |
| `power-off` | None | Request shutdown and wait for firmware to release power. |
| `wait` | `ms` | Wait in browser time while firmware continues running. |
| `press` | `control`, `ms` | Press a button/pad, wait, and release. |
| `button` | `control`, `down`: boolean | Hold or release a button/pad; useful for combinations. |
| `encoder` | `control`, `delta`: signed integer | Turn an encoder by 1–128 steps in either direction. |
| `midi` | `data`: array of byte integers | Inject 1–1024 MIDI bytes via the configured emulator route. |

Controls use the panel names: `tap`, `record`, `stop`, `play`, `control`, `project`, `global`, `pattern`, `gate`, `pitch`, `mod`, `loop`, `shift`, `bar1`–`bar4`, `trackA`–`trackD`, and pads `A1`–`D16`. Encoders are `tempo`, `swing`, and `param1`–`param4`. Durations are integer milliseconds from 0 to 3,600,000. Files are limited to 1 MiB, 10,000 actions, and a 120-character name; all actions are validated before execution. Unknown fields and unsupported versions are rejected.

Button and encoder actions wait for queued input and its virtual scan/debounce interval before the next action. Timed presses include that minimum interval in addition to their browser-time duration. Host speed and background-tab throttling affect timing; scripts are not a deterministic virtual-time replay format. Existing **Save input recording** / **Replay recording** remain separate tick-based diagnostic tools.

## Debugging firmware

**Validate Image** runs the pinned SQ-64 spec v0.2.0 `image` profile against the exact file loaded into the emulator. All seven requirements appear with pass/fail/not-run results, the file hash and the spec revision. **Save validation report** exports JSON; execution and debug reports also include the last validation. It works while running, paused, stopped at a breakpoint, or faulted without changing CPU/debugger state. Updater and backup transaction locks disable the action.

The spec requires a full VSB: raw BIN and ELF inputs fail `PKG-001` and leave six checks not-run. The original file is retained across resets, so results do not cover later emulated storage writes or installed updates. A successful image replacement clears validation. These are package checks, not software execution or hardware certification. No network fetch, upload, or Python runtime is needed in the browser.

Expand **Developer debugging** after loading an image and select **Enable debugging**. The emulator pauses and displays CPU registers, breakpoints, a code/RAM memory viewer and recent instruction opcode bytes. **Step 1 instruction** advances one CPU instruction boundary. Enter decimal or `0x` hexadecimal addresses, then choose **Apply breakpoints and trace**; an empty list removes all breakpoints. **Run** continues past a breakpoint once and stops again if execution returns to it.

Debugging is off by default. Enabling it uses slower per-instruction execution; disabling it restores the accelerated engine without resetting the machine. Reset keeps the configuration and pauses at the reset vector, while loading a new image clears it. Incoming MIDI does not resume a paused debugger. The controls are disabled during updater/backup operations.

**Save debug report** downloads registers, up to 4096 recent instruction hook entries (default 256), faults, board and interrupt diagnostics, and the image hash. A trace limit of zero disables tracing. Memory inspection is limited to 4096 bytes of mapped code/RAM per request and never reads peripherals. This is an address-level debugger: ELF source symbols, source stepping, watchpoints and GDB remote connections are not implemented. Trace entries run before execution and can include a faulting or preempted instruction. Files and diagnostics stay local unless you download and share them.

## GitHub Pages from a branch

GitHub Pages branch publishing selects the branch root or `/docs`, not an arbitrary `/web` folder. Keep `web/` as the development source; export **only its deployable contents** to the root of a separate deployment branch:

```sh
npm run build -- --out /tmp/sq64-pages-export
```

The output directory must be empty or absent. Review that export, copy its contents into the root of your deployment branch, commit and push when ready, then select that branch and `/ (root)` in Pages settings. The command itself does not alter Git branches, commit, push or deploy. Alternatively, `npm run build` refreshes the disposable `web/dist/` output.

The export contains the updater, browser emulator, image conformance validator and metadata, fonts, branding, original diagnostic probe, licenses, complete Unicorn corresponding source, `.nojekyll`, and `CNAME` for `sq64.alephvoid.com`. It excludes tests, development dependencies, native Python code and the full conformance project. Never copy private firmware into this tree.

URLs are relative, so the app also runs below a repository URL path. Remove/change `CNAME` and canonical metadata if intentionally deploying elsewhere. Configure custom-domain DNS and HTTPS separately. `_headers` is for hosts that support it; GitHub Pages does not use this file, so the app also includes its content security policy in HTML. Same-origin embedding and WebAssembly are permitted, without cross-origin isolation, SharedArrayBuffer, an API server or a service worker.

## Browser coverage

Current browser engines with WebAssembly, BigInt and module workers can run the emulator on Linux, macOS and Windows. The suite has been executed with Chromium on Linux. Physical MIDI access depends on the browser's Web MIDI/SysEx support. The GUI reports unavailable MIDI without preventing emulator use.

The complete board model remains experimental. An emulator pass alone is not a reason to flash candidate firmware. The included probe is original integration-test code, not a release for a real SQ-64.

## Official firmware download

The update panel and the emulator page link directly to Korg's official updater ZIP and download page. Download the ZIP in the browser, extract the single `.VSB`, and load it as a local file. The app never fetches from `cdn.korg.com` itself: the CDN omits browser CORS permission, so an in-app download is not possible, and there is no proxy or fallback flow. No vendor firmware is bundled or uploaded.

## Startup speed

Load the extracted firmware in the **Browser emulator** section, then press **Power on**. The updater's file selector is separate. Startup runs real firmware initialization; its first display frame and USB readiness occur at different times. A blank initial display does not mean execution has stopped. The workbench shows startup status and an increasing instruction count. On the test host, stock/custom cold starts showed their first frame after about four seconds and configured USB after approximately one minute.
