"""Portable loopback workbench. The browser never receives a host filesystem API."""
import hashlib
from copy import deepcopy
import json
import mimetypes
from pathlib import Path
import secrets
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from .core import Machine
from .image import Image, FLASH
from .conformance import critical_stop, validate_image

class Workbench:
    def __init__(self, content=None, mapping=None, debug=None):
        self.mapping = mapping; self.content = bytes(content) if content is not None else None; self.debug_options = debug
        self.machine = Machine(self.content, panel_mapping=mapping, debug=debug) if content else None
        self.conformance = None
        self.terminated_state = None
        self.running = False; self.mode = 'normal'; self.lock = threading.RLock()
        self.stop = threading.Event(); self.midi = None; self.midi_error = None
        self.worker = threading.Thread(target=self.loop, daemon=True); self.worker.start()

    def loop(self):
        while not self.stop.wait(.005):
            with self.lock:
                if self.machine and self.midi:
                    try: self.midi.pump(self.machine)
                    except Exception as error: self.midi_error = str(error); self.running = False
                if self.running and self.machine:
                    self.machine.run(2000)
                    if self.halt_critical(): continue
                    if self.machine.error or self.machine.breakpoint is not None or self.machine.debug.stopped_at is not None: self.running = False

    def reset(self, mode):
        if self.terminated_state: raise ValueError(self.terminated_state['terminated']['message'])
        if mode not in ('normal', 'version', 'update'): raise ValueError('Unknown boot mode')
        if not self.machine: raise ValueError('Load firmware first')
        self.running = False; previous = self.machine
        # A reset retains the emulated flash, including writes by candidate code.
        internal = bytes(previous.uc.mem_read(FLASH, 0x10000)); spi = bytes(previous.board.flash.data)
        image = Image([(FLASH, internal)] + [(a, d) for a, d in previous.image.segments if a != FLASH], spi, FLASH, hashlib.sha256(internal + spi).hexdigest(), 'reset-state')
        self.machine = Machine(image, panel_mapping=self.mapping, debug=previous.debug.config())
        self.machine.critical.image_sha256 = previous.critical.image_sha256
        self.mode = mode
        if mode != 'normal':
            self.machine.event({'type': 'button', 'control': 'global', 'down': True})
            if mode == 'update': self.machine.event({'type': 'button', 'control': 'pattern', 'down': True})
        if self.midi: self.midi.output_index = 0

    def state(self):
        if self.terminated_state: return deepcopy(self.terminated_state)
        if not self.machine: return {'loaded': False, 'running': False, 'midi': self.midi_error or 'disabled'}
        return {'loaded': True, 'running': self.running, 'mode': self.mode, 'report': dict(self.machine.report(), conformance=self.conformance),
                'panel': self.machine.board.panel.snapshot(), 'midi': self.midi.status() if self.midi else self.midi_error or 'disabled'}

    def validate(self):
        # The request holds self.lock, so execution/MIDI cannot advance between
        # receiving the report and latching the terminal state.
        self.conformance = validate_image(self.content)
        self.terminate(critical_stop(self.conformance))

    def halt_critical(self):
        if self.terminated_state: return True
        stop = self.machine and critical_stop(self.machine.critical.report())
        if stop: self.terminate(stop)
        return bool(stop)

    def terminate(self, stop):
        if stop and not self.terminated_state:
            self.running = False
            snapshot = self.state()
            snapshot.update(terminated=stop, midi='disconnected')
            snapshot['report']['status'] = 'terminated'
            self.terminated_state = deepcopy(snapshot)
            self.stop.set()
            self.machine = None
            if self.midi:
                midi, self.midi = self.midi, None
                midi.close()

    def close(self):
        self.stop.set(); self.worker.join(timeout=5)
        if self.midi: self.midi.close()

def make_server(workbench, port=0):
    root = Path(__file__).with_name('ui').resolve()
    token = secrets.token_urlsafe(32)
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def reply(self, code, data, kind='application/json'):
            payload = data if isinstance(data, bytes) else json.dumps(data).encode()
            self.send_response(code); self.send_header('Content-Type', kind)
            self.send_header('Content-Length', str(len(payload))); self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Content-Security-Policy', "default-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
            self.end_headers(); self.wfile.write(payload)
        def allowed(self):
            host = f'127.0.0.1:{self.server.server_port}'
            return self.headers.get('Host') == host and self.headers.get('Origin', f'http://{host}') == f'http://{host}'
        def do_GET(self):
            if not self.allowed(): self.reply(403, {'error': 'Loopback origin required'}); return
            if self.path == '/api/session': self.reply(200, {'token': token}); return
            if self.path == '/api/state':
                with workbench.lock: self.reply(200, workbench.state())
                return
            if self.path == '/api/replay':
                with workbench.lock: self.reply(200, workbench.machine.board.panel.events if workbench.machine else [])
                return
            path = root / ('index.html' if self.path == '/' else self.path.lstrip('/'))
            if not path.resolve().is_relative_to(root) or not path.is_file(): self.reply(404, {'error': 'Not found'}); return
            self.reply(200, path.read_bytes(), mimetypes.guess_type(path.name)[0] or 'application/octet-stream')
        def do_POST(self):
            if not self.allowed() or self.headers.get('X-Session-Token') != token:
                self.reply(403, {'error': 'Local session token required'}); return
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 4 * 1024 * 1024: raise ValueError('Invalid request size')
                raw = self.rfile.read(length)
                with workbench.lock:
                    if workbench.terminated_state and self.path != '/api/state':
                        raise ValueError(workbench.terminated_state['terminated']['message'])
                    if self.path == '/api/load':
                        machine = Machine(raw, panel_mapping=workbench.mapping, debug=workbench.debug_options)
                        workbench.running = False; workbench.machine = machine; workbench.content = raw; workbench.mode = 'normal'
                        workbench.conformance = None
                    else:
                        data = json.loads(raw)
                        if self.path == '/api/state': self.reply(200, workbench.state()); return
                        if not workbench.machine: raise ValueError('Load a firmware image first')
                        if self.path == '/api/run': workbench.running = True
                        elif self.path == '/api/pause': workbench.running = False
                        elif self.path == '/api/validate': workbench.validate()
                        elif self.path == '/api/step': workbench.running = False; workbench.machine.run(min(100000, max(1, int(data.get('instructions', 1)))))
                        elif self.path == '/api/debug':
                            workbench.machine.debug.configure(**data); workbench.running = False
                        elif self.path == '/api/debug-memory':
                            if workbench.running: raise ValueError('Pause before inspecting memory')
                            self.reply(200, workbench.machine.debug.memory(data['address'], data.get('length', 128))); return
                        elif self.path == '/api/state': pass
                        elif self.path == '/api/reset': workbench.reset(data.get('mode', 'normal'))
                        elif self.path == '/api/event': workbench.machine.event(data)
                        elif self.path == '/api/replay': workbench.machine.replay(data)
                        elif self.path == '/api/storage':
                            content = bytes.fromhex(data['hex'])
                            if len(content) != 0x100000: raise ValueError('Storage snapshot must be 1 MiB')
                            workbench.running = False; workbench.machine.board.flash.data[:] = content
                        else: raise ValueError('Unknown operation')
                    workbench.halt_critical()
                    self.reply(200, workbench.state())
            except (ValueError, KeyError, TypeError) as error: self.reply(400, {'error': str(error)})
    return ThreadingHTTPServer(('127.0.0.1', port), Handler)

def serve(args, mapping):
    workbench = Workbench(args.image.read_bytes() if args.image else None, mapping, args.debug_options)
    if args.midi:
        from .midi import open_bridge
        try: workbench.midi = open_bridge(input_port=args.midi_input, output_port=args.midi_output,
            transport=args.midi_transport)
        except Exception as error: workbench.midi_error = str(error)
    server = make_server(workbench, args.port)
    url = f'http://127.0.0.1:{server.server_port}'
    print(url, flush=True)
    if not args.no_browser: webbrowser.open(url)
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally: server.server_close(); workbench.close()
