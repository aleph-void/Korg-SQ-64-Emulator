#!/usr/bin/env python3
"""Reproduce QEMU 10.2.1's Emscripten dependencies from pinned local archives."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[1]
PINNED = {
    'zlib-1.3.1.tar.gz': '9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23',
    'libffi-3.4.7.tar.gz': 'f07c08c9c14977eafb9b5f9277713d91358ec18fc8aaa5607d6790cde90cba12',
    'glib-2.84.0.tar.xz': 'f8823600cb85425e2815cfad82ea20fdaa538482ab74e7293d58b3f64a5aff6a',
}

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--emscripten', type=Path, required=True)
    p.add_argument('--jobs', type=int, default=2)
    a = p.parse_args()
    if not 1 <= a.jobs <= 2: p.error('jobs must be 1 or 2')
    base = ROOT / 'build'; source = base / 'wasm-deps-source'; target = base / 'wasm-deps'
    source.mkdir(parents=True, exist_ok=True); target.mkdir(exist_ok=True)
    for name, digest in PINNED.items():
        path = base / 'wasm-deps-cache' / name
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest: raise ValueError('Archive digest mismatch: ' + name)
        with tarfile.open(path) as archive:
            top = Path(archive.getmembers()[0].name).parts[0]
            if not (source / top).exists(): archive.extractall(source, filter='data')
    env = dict(os.environ)
    env.update(PATH=str(a.emscripten.resolve()) + os.pathsep + env['PATH'],
               CPATH=str(target / 'include'), PKG_CONFIG_PATH=str(target / 'lib/pkgconfig'),
               EM_PKG_CONFIG_PATH=str(target / 'lib/pkgconfig'),
               PKG_CONFIG_LIBDIR=str(target / 'lib/pkgconfig'),
               CFLAGS='-O3 -pthread -DWASM_BIGINT', CXXFLAGS='-O3 -pthread -DWASM_BIGINT',
               LDFLAGS='-sWASM_BIGINT -sASYNCIFY=1 -L' + str(target / 'lib'))
    def run(args, cwd):
        print('+', args, flush=True); subprocess.run(args, cwd=cwd, env=env, check=True)
    zlib = source / 'zlib-1.3.1'
    run(['emconfigure', './configure', '--prefix=' + str(target), '--static'], zlib)
    run(['emmake', 'make', 'install', '-j' + str(a.jobs)], zlib)
    ffi = source / 'libffi-3.4.7'
    if not (ffi / 'configure').exists(): run(['autoreconf', '-fiv'], ffi)
    run(['emconfigure', './configure', '--host=wasm32-unknown-linux', '--prefix=' + str(target),
         '--enable-static', '--disable-shared', '--disable-dependency-tracking', '--disable-builddir',
         '--disable-multi-os-directory', '--disable-raw-api', '--disable-docs'], ffi)
    run(['emmake', 'make', 'install', 'SUBDIRS=include', '-j' + str(a.jobs)], ffi)
    stub = source / 'resolver-stub'; stub.mkdir(exist_ok=True)
    (stub / 'res_query.c').write_text('#include <netdb.h>\nint res_query(const char *n, int c, int t, unsigned char *d, int l) { h_errno = HOST_NOT_FOUND; return -1; }\n')
    run(['emcc', '-O3', '-pthread', '-DWASM_BIGINT', '-c', 'res_query.c', '-fPIC', '-o', 'libresolv.o'], stub)
    run(['emar', 'rcs', str(target / 'lib/libresolv.a'), 'libresolv.o'], stub)
    cross = base / 'wasm-deps.cross'
    cross.write_text("""[host_machine]
system = 'emscripten'
cpu_family = 'wasm32'
cpu = 'wasm32'
endian = 'little'
[binaries]
c = 'emcc'
cpp = 'em++'
ar = 'emar'
ranlib = 'emranlib'
pkg-config = ['pkg-config', '--static']
[built-in options]
c_args = ['-O3', '-pthread', '-DWASM_BIGINT', '-Wno-incompatible-function-pointer-types']
cpp_args = ['-O3', '-pthread', '-DWASM_BIGINT']
c_link_args = ['-sWASM_BIGINT', '-sASYNCIFY=1', '-pthread', '-L%s']
cpp_link_args = ['-sWASM_BIGINT', '-sASYNCIFY=1', '-pthread', '-L%s']
""" % (target / 'lib', target / 'lib'))
    glib = source / 'glib-2.84.0'
    # PCRE2 source and Meson patch checksums are also pinned by GLib's wrap file.
    if not (glib / '_build/build.ninja').exists():
        run(['meson', 'setup', '_build', '--prefix=' + str(target), '--cross-file=' + str(cross),
             '--default-library=static', '--buildtype=release', '--force-fallback-for=pcre2',
             '--wrap-mode=nodownload', '-Dselinux=disabled', '-Dxattr=false', '-Dlibmount=disabled',
             '-Dnls=disabled', '-Dtests=false', '-Dglib_debug=disabled', '-Dglib_assert=false', '-Dglib_checks=false'], glib)
    config = glib / '_build/config.h'
    text = config.read_text().replace('#define HAVE_POSIX_SPAWN 1', '/* Emscripten: no posix_spawn */').replace('#define HAVE_PTHREAD_GETNAME_NP 1', '/* Emscripten: no pthread_getname_np */')
    config.write_text(text)
    run(['ninja', '-C', '_build', '-j' + str(a.jobs)], glib)
    run(['meson', 'install', '-C', '_build', '--no-rebuild'], glib)
    receipt = {'archives': PINNED, 'emscripten': subprocess.check_output([str(a.emscripten / 'emcc'), '--version'], text=True).splitlines()[0],
               'recipe_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
               'target_files': {str(p.relative_to(target)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(target.rglob('*')) if p.is_file()}}
    (target / 'dependencies.json').write_text(json.dumps(receipt, indent=2) + '\n')

if __name__ == '__main__': main()
