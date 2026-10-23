#!/usr/bin/env python3
"""Build the native SQ-64 board from a checksum-pinned local QEMU archive."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
VERSION = "10.2.1"
ARCHIVE_SHA256 = "a3717477d8e2c84d630bfffbc20f6cd3293eb45aa1e6dac6d0cc27689991c9e1"
URL = f"https://download.qemu.org/qemu-{VERSION}.tar.xz"


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True,
                        help="local qemu-10.2.1.tar.xz; no implicit downloads")
    parser.add_argument("--jobs", type=int, default=min(2, os.cpu_count() or 1))
    parser.add_argument("--build-root", type=Path, default=ROOT / "build",
                        help="Independent source/output root for fresh-worker qualification")
    parser.add_argument("--prepare-only", action="store_true",
                        help="Validate/extract/apply reviewed sources without compiling")
    args = parser.parse_args()
    if not 1 <= args.jobs <= 2:
        parser.error("--jobs must be in 1..2")
    if sha256(args.archive) != ARCHIVE_SHA256:
        raise ValueError("QEMU archive SHA-256 mismatch")
    source = args.build_root.resolve() / "qemu-source"
    build = args.build_root.resolve() / "qemu"
    if not source.exists():
        source.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="qemu-extract-", dir=source.parent) as tmp:
            stage = Path(tmp) / "source"
            stage.mkdir()
            with tarfile.open(args.archive) as archive:
                members = archive.getmembers()
                for member in members:
                    parts = Path(member.name).parts
                    if not parts or parts[0] != f"qemu-{VERSION}":
                        raise ValueError("Unexpected QEMU archive root")
                    member.name = "/".join(parts[1:])

                def safe_filter(member, destination):
                    # Pinned EDK2 host X11 symlink is not used by this build.
                    if member.issym() and Path(member.linkname).is_absolute():
                        return None
                    return tarfile.data_filter(member, destination)

                archive.extractall(stage, members=[m for m in members if m.name],
                                   filter=safe_filter)
            (stage / ".av-sq64-source").write_text(ARCHIVE_SHA256 + "\n")
            stage.rename(source)
    if ((source / "VERSION").read_text().strip() != VERSION or
            (source / ".av-sq64-source").read_text().strip() != ARCHIVE_SHA256):
        raise ValueError("QEMU source was not staged by this locked build recipe")
    board = ROOT / "tools/qemu/sq64.c"
    model_sources = sorted((ROOT / "tools/qemu").glob("sq64*"))
    for path in model_sources:
        destination = source / "hw/arm" / path.name
        if not destination.exists() or destination.read_bytes() != path.read_bytes():
            shutil.copyfile(path, destination)
    meson = source / "hw/arm/meson.build"
    text = meson.read_text()
    if "'sq64.c'" not in text:
        meson.write_text(text + "\narm_ss.add(when: 'CONFIG_SQ64', if_true: files('sq64.c'))\n")
    kconfig=source/'hw/arm/Kconfig'
    text=kconfig.read_text()
    if 'config SQ64' not in text:
        kconfig.write_text(text+'\nconfig SQ64\n    bool\n    select ARM_V7M\n')
    config=source/'configs/devices/arm-softmmu/default.mak'
    text=config.read_text()
    if 'CONFIG_SQ64=y' not in text:config.write_text(text+'\nCONFIG_SQ64=y\n')
    if args.prepare_only:
        print(f"Prepared isolated source {source}; build and acceptance not run")
        return
    build.mkdir(parents=True, exist_ok=True)
    if not (build / "build.ninja").exists():
        subprocess.run([
            str(source / "configure"), "--target-list=arm-softmmu",
            "--disable-docs", "--disable-download", "--disable-werror", "--without-default-devices",
            "--disable-gtk", "--disable-sdl", "--disable-vnc", "--disable-spice",
            "--disable-opengl", "--disable-curses", "--disable-tools",
            "--disable-guest-agent", "--disable-slirp",
        ], cwd=build, check=True)
    subprocess.run(["ninja", "-C", str(build), f"-j{args.jobs}", "qemu-system-arm"], check=True)
    report = {
        "qemu_version": VERSION, "source_url": URL, "archive_sha256": ARCHIVE_SHA256,
        "board_sha256": sha256(board), "recipe_sha256": sha256(Path(__file__)),
        "model_sources_sha256": {str(p.relative_to(ROOT)): sha256(p) for p in model_sources},
        "binary_sha256": sha256(build / "qemu-system-arm"),
        "build_environment": {
            "compiler": subprocess.check_output(["cc", "--version"], text=True).splitlines()[0],
            "compiler_sha256": sha256(Path(shutil.which("cc")).resolve()),
            "ninja": subprocess.check_output(["ninja", "--version"], text=True).strip(),
            "ninja_sha256": sha256(Path(shutil.which("ninja")).resolve()),
            "host_packages": subprocess.check_output(
                ["dpkg-query", "-W", "-f=${binary:Package}\\t${Version}\\n"], text=True).splitlines(),
        },
        "migration_complete": False, "firmware_acceptance": "not-run",
        "scope": "native Cortex-M7/NVIC and SQ-64 peripherals; qualification in progress",
    }
    (build / "sq64-build.json").write_text(json.dumps(report, indent=2) + "\n")
    print(f"Built {build / 'qemu-system-arm'}")


if __name__ == "__main__":
    main()
