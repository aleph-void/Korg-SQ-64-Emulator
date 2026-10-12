"""Independent host tooling. Firmware is always supplied by the user."""
from pathlib import Path

_version_file = Path(__file__).resolve().parent.parent / 'VERSION'
if _version_file.is_file():
    __version__ = _version_file.read_text().strip()
else:
    from importlib.metadata import version as _dist_version
    __version__ = _dist_version('sq64-emulator')
