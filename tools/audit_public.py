#!/usr/bin/env python3
"""Check the public boundary and integrity of the two deliberately shipped binaries."""
import argparse
import hashlib
import json
from pathlib import Path
import re

IGNORE = {'.git', 'node_modules', '__pycache__', '.venv', 'build', 'dist', 'test-results', 'playwright-report'}

def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('root', type=Path, nargs='?', default=Path(__file__).resolve().parents[1]); args = parser.parse_args()
    root = args.root.resolve(); manifest = json.loads((root / 'tools/public-artifacts.json').read_text()); failures = []; count = 0
    for relative, expected in manifest.items():
        path = root / relative
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != expected: failures.append(f'Artifact hash mismatch: {relative}')
    for path in root.rglob('*'):
        relative = path.relative_to(root)
        if any(part in IGNORE or part.endswith('.egg-info') for part in relative.parts) or not path.is_file(): continue
        count += 1
        if path.is_symlink(): failures.append(f'Public file is a symlink: {relative}')
        if path.suffix.lower() in {'.vsb', '.elf', '.bin'} and str(relative) not in manifest: failures.append(f'Unexpected device image: {relative}')
        if any(part in {'recomp', 'decompiled', 'ghidra', 'firmware-dumps'} for part in relative.parts): failures.append(f'Private reference tree: {relative}')
        if path.suffix in {'.c', '.h', '.py', '.js'} and path.name != 'unicorn-arm.js':
            content = path.read_text()
            if re.search(r'\b(?:FUN|DAT|LAB)_[0-9a-fA-F]{8}\b', content): failures.append(f'Decompiler symbol: {relative}')
    if failures: raise SystemExit('\n'.join(failures))
    print(f'Public boundary audit passed: {count} files; {len(manifest)} explicit artifact hashes. Ignored development outputs are never deployment inputs.')

if __name__ == '__main__': main()
