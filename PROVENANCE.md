# Public-source boundary

This repository distributes original host-side implementations of interfaces and independently authored diagnostic programs. It distributes no original SQ-64 firmware, decompiled firmware, reconstructed firmware functions, factory samples, display assets, calibration data or user backups.

Protocol bytes, file-format tags, memory addresses and register facts are interoperability information. Knowledge of those facts came from published documentation and observations of a private reference project. The emulator's exception model also adapts original host test-harness code from that project, not code extracted from firmware. This is an evidence boundary, not a claim that the developers had no access to the reference implementation.

The files in `examples/` are original C diagnostic programs. The only prebuilt device-code file allowed in the public tree is `web/examples/browser-probe.bin`, reproducible from `examples/browser_probe.c`, `examples/probe.ld` and `examples/build_browser_probe.py`. It is for emulator tests only. WebAssembly CPU-engine bytes implement Unicorn, not SQ-64 firmware. Complete third-party source, notices and a build driver are in `web/vendor/`.

Aleph Void's local site supplied the requested brand palette and logo. Inter and JetBrains Mono are distributed with their OFL notices. Korg names identify interoperability targets and are not this project's branding.

Reference documents:
- Korg SQ-64 manuals and published MIDI implementation: https://www.korg.com/us/support/download/product/0/872/
- Product specifications: https://www.korg.com/us/products/dj/sq_64/specifications.php
- ST Cortex-M7 programming manual PM0253 and STM32F7 register documentation (specific board part and wiring remain subject to verification).
- Web MIDI: https://www.w3.org/TR/webmidi/
- Unicorn and unicorn.js source references and exact hashes: `tools/wasm-sources.json`.

Run `python3 tools/audit_public.py .` before publication. The audit catches known accidental inclusions; it does not prove that arbitrary future contributions have acceptable provenance. New contributions must identify their source and use original fixtures.

The official-download links store only Korg URLs. The user downloads firmware from Korg directly; this repository does not fetch, redistribute, or contain that ZIP or its contents.

## Image conformance integration

The image profile uses the MIT-licensed [independent SQ-64 specification](https://github.com/aleph-void/Korg-SQ-64-Custom-Firmware-Spec/tree/a71297981a601b5e69e5d44dc44ada897050df3d), version 0.2.0, commit `a71297981a601b5e69e5d44dc44ada897050df3d`. The unmodified evaluator, dependencies, catalog and board contract are vendored in `sq64_emulator/_vendor/sq64_spec/`, with its original license. The browser port is `web/emulator/conformance/validate.js`; its metadata and license are generated with `python tools/sync_conformance.py`. `--check` detects generated-file drift. Cross-language tests compare complete reports against the vendored evaluator for valid, malformed and boundary inputs. Updating the spec requires reviewing/replacing the pinned sources, updating the revision in `sq64_emulator/conformance.py`, regenerating metadata and rerunning parity tests. Firmware is never fetched or distributed by this integration.
