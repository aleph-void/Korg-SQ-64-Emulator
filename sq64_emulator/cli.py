import argparse
import json
from pathlib import Path
from .core import Machine

def main():
    parser = argparse.ArgumentParser(description='Aleph Void SQ-64 firmware workbench. No firmware is bundled.')
    parser.add_argument('image', nargs='?', type=Path)
    parser.add_argument('--headless', action='store_true')
    parser.add_argument('--instructions', type=int, default=100000)
    parser.add_argument('--report', type=Path)
    parser.add_argument('--replay', type=Path)
    parser.add_argument('--panel-map', type=Path)
    parser.add_argument('--port', type=int, default=4174)
    parser.add_argument('--no-browser', action='store_true')
    parser.add_argument('--midi', action='store_true', help='Opt in to an optional native MIDI bridge')
    parser.add_argument('--midi-transport', choices=['usb', 'din'], default='usb')
    parser.add_argument('--midi-input'); parser.add_argument('--midi-output')
    args = parser.parse_args()
    mapping = json.loads(args.panel_map.read_text()) if args.panel_map else None
    if args.headless:
        if not args.image: parser.error('headless execution needs an image')
        machine = Machine(args.image.read_bytes(), panel_mapping=mapping)
        if args.replay: machine.replay(json.loads(args.replay.read_text()))
        report = machine.run(args.instructions)
        text = json.dumps(report, indent=2)
        if args.report: args.report.write_text(text + '\n')
        else: print(text)
        raise SystemExit(1 if report['error'] else 0)
    from .server import serve
    serve(args, mapping)
