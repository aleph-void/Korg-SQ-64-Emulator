#!/usr/bin/env python3
"""Build the ARM-only ES module from pinned, locally supplied upstream sources."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[1]

def run(*args, cwd): subprocess.run(args, cwd=cwd, check=True)

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--sources', type=Path, required=True, help='Directory containing upstream archives from the corresponding-source bundle')
    p.add_argument('--work', type=Path, required=True, help='New build directory')
    p.add_argument('--output', type=Path, default=ROOT / 'web/vendor/unicorn-arm.js')
    args = p.parse_args()
    manifest = json.loads((Path(__file__).with_name('wasm-sources.json')).read_text())
    args.work.mkdir(parents=True, exist_ok=False)
    for entry in manifest['archives']:
        archive = args.sources / entry['file']
        if hashlib.sha256(archive.read_bytes()).hexdigest() != entry['sha256']: raise ValueError('Source archive digest mismatch: ' + entry['file'])
        with tarfile.open(archive) as tar:
            for member in tar.getmembers():
                target = (args.work / member.name).resolve()
                if not target.is_relative_to(args.work.resolve()) or member.issym() or member.islnk(): raise ValueError('Unsafe source archive member')
            tar.extractall(args.work)
    wrapper = args.work / ('unicorn.js-' + manifest['wrapperCommit'])
    upstream = args.work / ('unicorn-' + manifest['unicornCommit'])
    # GitHub's wrapper archive includes an empty submodule directory.
    target = wrapper / 'unicorn'
    if target.exists(): target.rmdir()
    upstream.rename(target)
    run('git', 'apply', str(Path(__file__).with_name('unicorn-2.1.3-itstate.patch')), cwd=target)
    driver = wrapper / 'build.py'
    source = driver.read_text().replace('jobs = os.cpu_count() or 1', 'jobs = 4').replace('jobs = multiprocessing.cpu_count()', 'jobs = 4')
    driver.write_text(source)
    os.environ.setdefault('EM_CACHE', str(args.work.resolve() / 'emscripten-cache'))
    run('python3', 'build.py', 'arm', cwd=wrapper)
    module = importlib.util.spec_from_file_location('wasm_upstream_build', driver)
    build = importlib.util.module_from_spec(module); module.loader.exec_module(build)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    exports = build.EXPORTED_FUNCTIONS + ['_sq64_bridge_new', '_sq64_bridge_free']
    run('emcc', '-O3', '-I', str(target / 'include'), str(Path(__file__).with_name('wasm_bridge.c')),
        str(target / 'build/libunicorn.a'), '-s', f'EXPORTED_FUNCTIONS={exports}',
        '-s', "EXPORTED_RUNTIME_METHODS=['ccall','getValue','setValue','addFunction','removeFunction','writeArrayToMemory']",
        '-s', 'ALLOW_TABLE_GROWTH=1', '-s', 'ALLOW_MEMORY_GROWTH=1', '-s', 'MODULARIZE=1', '-s', 'EXPORT_ES6=1',
        '-s', 'SINGLE_FILE=1', '-s', 'WASM_BIGINT=1', '-s', 'EXPORT_NAME=MUnicorn',
        '--post-js', str(wrapper / 'src/constants_arm.js'), '--post-js', str(wrapper / 'src/unicorn-wrapper.js'),
        '-o', str(args.output.resolve()), cwd=wrapper)

if __name__ == '__main__': main()
