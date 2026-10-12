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

The official-download button stores only a Korg URL and the verified 2.03 VSB digest. It fetches firmware into the user's browser on request, subject to Korg's CORS policy. It does not redistribute that ZIP or its contents in this repository.
