#!/usr/bin/env python3
"""Build the same SQ-64 native board using upstream QEMU's wasm32 TCI backend."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--archive', type=Path, required=True)
    p.add_argument('--emscripten', type=Path, required=True)
    p.add_argument('--jobs', type=int, default=2)
    a = p.parse_args()
    if not 1 <= a.jobs <= 2: p.error('jobs must be 1 or 2')
    target = ROOT / 'build/wasm-deps'; receipt = json.loads((target / 'dependencies.json').read_text())
    for name, digest in receipt['target_files'].items():
        if sha(target / name) != digest: raise ValueError('WASM dependency changed: ' + name)
    stage = ROOT / 'build/wasm'
    subprocess.run([sys.executable, str(ROOT / 'tools/build_qemu.py'), '--archive', str(a.archive.resolve()),
                    '--build-root', str(stage), '--prepare-only'], check=True)
    source = stage / 'qemu-source'; build = stage / 'qemu'; build.mkdir(exist_ok=True)
    cross = source / 'configs/meson/emscripten.txt'
    original = cross.read_text()
    # Keep the upstream wasm coroutine/libffi/worker settings. Bound the initial
    # allocation and export only transport/runtime utilities used by our client.
    cross.write_text(original.replace("'-sTOTAL_MEMORY=2GB'", "'-sTOTAL_MEMORY=512MB'").replace(
        "'-sEXPORTED_RUNTIME_METHODS=addFunction,removeFunction,TTY,FS'",
        "'-sEXPORTED_RUNTIME_METHODS=addFunction,removeFunction,TTY,FS,UTF8ToString,PThread'"))
    env = dict(os.environ); env.update(PATH=str(a.emscripten.resolve()) + os.pathsep + env['PATH'],
        CPATH=str(target / 'include'), PKG_CONFIG_PATH=str(target / 'lib/pkgconfig'),
        EM_PKG_CONFIG_PATH=str(target / 'lib/pkgconfig'), PKG_CONFIG_LIBDIR=str(target / 'lib/pkgconfig'))
    def run(args): print('+', args, flush=True); subprocess.run(args, cwd=build, env=env, check=True)
    if not (build / 'build.ninja').exists():
        run([str(source / 'configure'), '--cc=emcc', '--cxx=em++', '--ar=emar', '--ranlib=emranlib', '--host-cc=cc',
             '--target-list=arm-softmmu', '--enable-tcg-interpreter', '--without-default-devices',
             '--disable-docs', '--disable-download', '--disable-werror', '--disable-strip',
             '--disable-gtk', '--disable-sdl', '--disable-vnc', '--disable-spice', '--disable-opengl',
             '--disable-curses', '--disable-tools', '--disable-guest-agent', '--disable-slirp',
             '--disable-pixman', '--disable-fdt',
             '--extra-cflags=-O3 -pthread -DWASM_BIGINT -Wno-incompatible-function-pointer-types',
             '--extra-ldflags=-L' + str(target / 'lib') +
             ' -sMODULARIZE=1 -sEXPORT_NAME=createQemu -sPTHREAD_POOL_SIZE=8 -sEXPORTED_FUNCTIONS=_main,_malloc,_free'])
    run(['ninja', '-j' + str(a.jobs), 'qemu-system-arm.js'])
    products = [p for p in build.glob('qemu-system-arm*') if p.suffix in ('.js', '.wasm', '.mjs')]
    if not any(p.suffix == '.wasm' for p in products): raise ValueError('QEMU WASM build product missing')
    destination = ROOT / 'web/vendor/qemu'; destination.mkdir(parents=True, exist_ok=True)
    for path in products: shutil.copy2(path, destination / path.name)
    result = dict(backend='qemu-tci-wasm32', qemu_version='10.2.1',
        recipe_sha256=sha(Path(__file__)), dependencies_sha256=sha(target / 'dependencies.json'),
        model_sources_sha256={str(p.relative_to(ROOT)):sha(p) for p in sorted((ROOT/'tools/qemu').glob('sq64*'))},
        products={p.name:sha(p) for p in products}, runtime_qualified=False)
    (destination / 'build.json').write_text(json.dumps(result, indent=2) + '\n')
    # Source and license publication is handled by the existing public-artifact
    # audit; this build alone does not mark the browser runtime as qualified.

if __name__ == '__main__': main()
