import argparse
import json
from pathlib import Path
from .core import Machine
from .debug import address, memory_range

def main():
    parser = argparse.ArgumentParser(description='Aleph Void SQ-64 firmware workbench. No firmware is bundled.')
    parser.add_argument('image', nargs='?', type=Path)
    parser.add_argument('--headless', action='store_true')
    parser.add_argument('--instructions', type=int, default=100000)
    parser.add_argument('--report', type=Path)
    parser.add_argument('--debug', action='store_true', help='Enable registers, breakpoints and a bounded instruction trace')
    parser.add_argument('--breakpoint', action='append', default=[], metavar='ADDRESS', help='Stop before this address; repeat for multiple breakpoints (requires --debug)')
    parser.add_argument('--trace-limit', type=int, default=None, metavar='N', help='Retain the last 0..4096 instruction hook entries (default 256; requires --debug)')
    parser.add_argument('--inspect', action='append', default=[], metavar='ADDRESS:LENGTH', help='Include code/RAM bytes in a headless report (requires --debug)')
    parser.add_argument('--replay', type=Path)
    parser.add_argument('--panel-map', type=Path)
    parser.add_argument('--port', type=int, default=4174)
    parser.add_argument('--no-browser', action='store_true')
    parser.add_argument('--midi', action='store_true', help='Opt in to an optional native MIDI bridge')
    parser.add_argument('--midi-transport', choices=['usb', 'din'], default='usb')
    parser.add_argument('--midi-input'); parser.add_argument('--midi-output')
    args = parser.parse_args()
    if (args.breakpoint or args.trace_limit is not None or args.inspect) and not args.debug:
        parser.error('--breakpoint, --trace-limit and --inspect require --debug')
    if args.inspect and not args.headless: parser.error('--inspect requires --headless')
    try:
        args.debug_options = {'enabled': args.debug, 'breakpoints': [address(value) for value in args.breakpoint], 'traceLimit': 256 if args.trace_limit is None else args.trace_limit}
        if len(args.breakpoint) > 64: raise ValueError('Use at most 64 breakpoints')
        for point in args.debug_options['breakpoints']: memory_range(point & ~1, 2)
        if not 0 <= args.debug_options['traceLimit'] <= 4096: raise ValueError('Trace limit must be 0..4096')
        inspections = []
        for spec in args.inspect:
            at, length = spec.split(':'); at, length = address(at), int(length, 0)
            memory_range(at, length); inspections.append((at, length))
    except ValueError as error: parser.error(str(error))
    mapping = json.loads(args.panel_map.read_text()) if args.panel_map else None
    if args.headless:
        if not args.image: parser.error('headless execution needs an image')
        machine = Machine(args.image.read_bytes(), panel_mapping=mapping, debug=args.debug_options)
        if args.replay: machine.replay(json.loads(args.replay.read_text()))
        report = machine.run(args.instructions)
        if inspections: report['debug']['memory'] = [machine.debug.memory(at, length) for at, length in inspections]
        text = json.dumps(report, indent=2)
        if args.report: args.report.write_text(text + '\n')
        else: print(text)
        raise SystemExit(1 if report['error'] else 0)
    from .server import serve
    serve(args, mapping)
