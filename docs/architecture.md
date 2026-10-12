# Execution and transport

```text
Browser updater / backup / restore
          │ same MidiSession interface
          ├─ Web MIDI input/output → physical SQ-64 (explicit permission)
          ├─ DemoSession → synthetic host-only protocol demonstration
          └─ BrowserEmulator ports → module Worker → ARM core → modeled UART/USB
                                                       │
                                                       └─ SPI / RAM / display / panel
```

`web/` is the entire browser application and deployment boundary. `web/src/` owns transport-independent protocol logic. `web/emulator/` owns the JS board/CPU integration and visual controls. `web/vendor/` holds the CPU engine and its complete corresponding source; the app does not fetch a CDN. A worker keeps firmware execution off the main GUI thread. Bounded chunks yield to incoming control and MIDI messages.

The panel iframe shares the parent page's `BrowserEmulator`; it does not create a second machine. The parent updater selects exactly one transport. Hardware ports are never opened implicitly when selecting the emulator. Firmware data never leaves the browser. The firmware CPU sees peripheral traffic, not host-implemented updater replies; the separately labeled DemoSession is the only host-level protocol fake.

The GUI disables machine replacement, resets and input during an updater/backup transaction. Transport timeout/disconnect closes the session, and updater errors after begin require an explicit new connection. The updater does not automatically retry erase/program traffic. An acknowledgement is never promoted to proof of programming completion or restored data persistence.

The Python core is an optional native counterpart for headless experimentation and regression tests. It has no role in the deployed site. A broader board contract lives in the sibling spec repository; image validation alone cannot establish physical hardware conformance.
