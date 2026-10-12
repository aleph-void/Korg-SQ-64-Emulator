# ARM WebAssembly engine

`unicorn-arm.js` is an ARM-only ES-module build of Unicorn through unicorn.js, with an IT-state hook correction. It contains a CPU engine, no SQ-64 firmware. Both upstream projects use GPL version 2; see COPYING and the licenses retained in their source trees. Original work in this repository is GPL-2.0-only. Fonts have their own OFL notices; Aleph Void branding remains its owner's property.

Upstream:
- https://github.com/AlexAltea/unicorn.js/tree/1220477c7fb0f8fe4b500f4bd211de52f6dfe638
- https://github.com/unicorn-engine/unicorn/tree/8028ec436f2d9376525352dd38ed9ed6b9f6be10

Download [the complete corresponding source and build recipe](unicorn-arm-source.tar.gz). The archive contains both complete upstream source archives, the local patch, source hashes and this project's build driver. No network fetch is performed by the driver. Build prerequisites: Emscripten 3.1.62 on PATH, CMake, Git, Python 3.10+, a C/C++ toolchain and approximately 2 GB free build space. Use a new absolute path for `--work`:

```sh
tar -xzf unicorn-arm-source.tar.gz
cd unicorn-arm-source
python3 emulator/tools/build_wasm.py --sources sources --work /tmp/sq64-wasm-build --output /tmp/unicorn-arm.js
```

Emscripten may populate its toolchain cache on the first build. The shipped engine includes the corrected Cortex-M7 CPU support and explicit 64-bit JS BigInt addresses. The patch preserves IT state at code hooks and allows interrupt injection before both true and false IT-block slots. The enclosing browser board model remains experimental; a correct CPU does not establish a correct circuit model.
