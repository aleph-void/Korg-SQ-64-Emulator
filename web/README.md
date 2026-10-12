# Aleph Void SQ-64 web app

All runtime content is under this directory. Serve it over HTTPS or localhost; opening `index.html` as a `file:` URL does not support module workers. The embedded emulator communicates directly with the updater using in-process MIDI-style ports. It neither requests Web MIDI permission nor creates an operating-system MIDI device. Real hardware uses Web MIDI with SysEx permission.

```sh
npm ci
npm run dev
npm test
npm run test:browser
npm run build
```

## Emulator shutdown and saved data

Use **Power off** and wait for **Powered off** before restarting after a restore. Firmware saves the current workspace and project catalog during this shutdown. **Power on**, **Version mode** and **Update mode** reset immediately. Closing or reloading the page discards the session, including its emulated flash; retain a downloaded backup outside the browser.

The panel shows firmware-driven LEDs and display output. LED styling currently represents on/off state in the Aleph Void accent color. Jack-voltage displays and CV/gate/sync traces are not implemented.

## GitHub Pages from a branch

GitHub Pages branch publishing selects the branch root or `/docs`, not an arbitrary `/web` folder. Keep `web/` as the development source; export **only its deployable contents** to the root of a separate deployment branch:

```sh
npm run build -- --out /tmp/sq64-pages-export
```

The output directory must be empty or absent. Review that export, copy its contents into the root of your deployment branch, commit and push when ready, then select that branch and `/ (root)` in Pages settings. The command itself does not alter Git branches, commit, push or deploy. Alternatively, `npm run build` refreshes the disposable `web/dist/` output.

The export contains the updater, browser emulator, fonts, branding, original diagnostic probe, licenses, complete Unicorn corresponding source, `.nojekyll`, and `CNAME` for `sq64.alephvoid.com`. It excludes tests, development dependencies, native Python code and the conformance project. Never copy private firmware into this tree.

URLs are relative, so the app also runs below a repository URL path. Remove/change `CNAME` and canonical metadata if intentionally deploying elsewhere. Configure custom-domain DNS and HTTPS separately. `_headers` is for hosts that support it; GitHub Pages does not use this file, so the app also includes its content security policy in HTML. Same-origin embedding and WebAssembly are permitted, without cross-origin isolation, SharedArrayBuffer, an API server or a service worker.

## Browser coverage

Current browser engines with WebAssembly, BigInt and module workers can run the emulator on Linux, macOS and Windows. The suite has been executed with Chromium on Linux. Physical MIDI access depends on the browser's Web MIDI/SysEx support. The GUI reports unavailable MIDI without preventing emulator use.

The complete board model remains experimental. An emulator pass alone is not a reason to flash candidate firmware. The included probe is original integration-test code, not a release for a real SQ-64.

## Official firmware download

The update panel and the emulator page link directly to Korg's official updater ZIP and download page. Download the ZIP in the browser, extract the single `.VSB`, and load it as a local file. The app never fetches from `cdn.korg.com` itself: the CDN omits browser CORS permission, so an in-app download is not possible, and there is no proxy or fallback flow. No vendor firmware is bundled or uploaded.

## Startup speed

Load the extracted firmware in the **Browser emulator** section, then press **Power on**. The updater's file selector is separate. Startup runs real firmware initialization; its first display frame and USB readiness occur at different times. A blank initial display does not mean execution has stopped. The workbench shows startup status and an increasing instruction count. On the test host, stock/custom cold starts showed their first frame after about four seconds and configured USB after approximately one minute.
