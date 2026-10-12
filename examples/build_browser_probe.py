"""Compile only original integration-test firmware. Never install it on a device."""
from pathlib import Path
import subprocess
root = Path(__file__).resolve().parents[1]
out = root / 'build'; out.mkdir(exist_ok=True)
subprocess.run(['arm-none-eabi-gcc', '-mcpu=cortex-m7', '-mthumb', '-Os', '-nostdlib', '-ffreestanding', '-fno-builtin', '-Wl,--build-id=none', '-T', str(root / 'examples/probe.ld'), str(root / 'examples/browser_probe.c'), '-o', str(out / 'browser-probe.elf')], check=True)
web = root / 'web/examples'; web.mkdir(exist_ok=True)
subprocess.run(['arm-none-eabi-objcopy', '-O', 'binary', '--gap-fill=0', '--pad-to=0x210000', str(out / 'browser-probe.elf'), str(web / 'browser-probe.bin')], check=True)
print(web / 'browser-probe.bin')
