"""Build only original test firmware; requires the GNU Arm toolchain."""
import argparse
from pathlib import Path
import shutil
import subprocess

def build(output):
    root = Path(__file__).resolve().parent
    compiler = shutil.which('arm-none-eabi-gcc')
    if not compiler: raise SystemExit('Install Arm GNU Toolchain (arm-none-eabi-gcc) to build the original test firmware')
    output = Path(output); output.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([compiler, '-mcpu=cortex-m7', '-mthumb', '-mfloat-abi=soft', '-O1', '-ffreestanding', '-fno-builtin', '-nostdlib', '-Wl,--build-id=none', '-T', str(root/'probe.ld'), str(root/'panel_probe.c'), '-o', str(output)], check=True)
    return output

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', default='build/panel-probe.elf')
    print(build(parser.parse_args().output))
