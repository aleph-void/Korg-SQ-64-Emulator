# How the SQ-64 emulation workflow was established

This account reconstructs the engineering workflow from public sources reviewed
on 2026-10-20 at emulator commit
`3d0f538f2bdc8549f5c9136189467d2f1e57436d`. It is not a recovered development
transcript. The initial public commit, `3f80704`, already contains native and
browser implementations, original ARM probes, the interrupt patch, and acceptance
notes. It cannot establish the order of discoveries before publication.

The [provenance statement](../PROVENANCE.md) explicitly credits published
documentation and observations of a private reference implementation. Original
host exception-harness code was adapted from that reference; vendor firmware
functions were not redistributed. This review did not access the private project,
firmware, backups, or captures. The five existing SQ-64 source pins in the shared
skills corpus matched their recorded hashes: README, PROVENANCE, architecture,
coverage, and the fidelity tests.

## Establish the image and execution contract

The reproducible starting point is package structure and reset vectors. The
[loader](../web/emulator/image.js) recognizes a `KORG SYSTEM FILE` VSB, checks its
`0x38100` total size and `0x38000` payload geometry, and accepts little-endian
ARM32 ELF or supported raw images separately. The vector table requires an
eight-byte-aligned stack within modeled SRAM and an odd Thumb reset address
within loaded segments. Those are concrete ISA/load clues; the physical MCU
identity remains unresolved.

Internal flash starts at `0x00200000`, with alias `0x08000000`; SRAM is
`0x20000000..0x20040000`. The payload's first 64 KiB supplies internal flash.
External storage is noncontiguous: payload `0x10000..0x14000` becomes SPI
`0..0x4000`, `0x34000..0x38000` becomes `0x4000..0x8000`, and
`0x14000..0x34000` becomes `0x10000..0x30000`. Firmware performs subsequent RAM
initialization and copying itself. The
[native loader regression](../tests/test_core.py) explicitly checks this without
preloading the application.

Keep loading distinct from conformance. The integrated validator adds product,
version, checksum-region and image-profile obligations; a runnable ELF is not a
conforming full VSB. The emulator pins specification 0.7.0, while the reviewed
[sibling contract](../../spec/docs/contracts.md) is 0.8.0. The latter supplies
supporting interface documentation, not evidence that newer requirements are
integrated. Four checksum regions detect corruption; they are not signatures.

## Make Cortex-M execution observable and correct

Unicorn supplies instruction execution, but the board needs explicit exception
delivery. The [interrupt model](../web/emulator/interrupts.js) handles pending and
enabled sources, priority ceilings, PRIMASK/FAULTMASK/BASEPRI, nested handlers,
MSP/PSP selection, stack alignment padding, EXC_RETURN tokens, and integer or
extended floating-point frames. Lazy FP preservation and restored xPSR/IT state
are part of that contract. Unsupported priority grouping or inconsistent
exception context faults rather than silently proceeding.

The critical engine failure was stale IT state at instruction hooks. An interrupt
inside Thumb conditional execution must stack the state *before that instruction*,
including a conditionally skipped slot. The
[Unicorn patch](../tools/unicorn-2.1.3-itstate.patch) moves hooks before the
predicate, publishes PC/conditional state, permits exits at every Thumb
instruction, and restores the translator invariant on continuation. The model
checks expected IT slots instead of concealing an incompatible engine.

The native backend pins Unicorn 2.1.3 and needs the patched library through
`LIBUNICORN_PATH` for longer interrupt-heavy runs; the bundled browser engine
uses patched 2.1.4. [WASM regressions](../web/tests/wasm.test.js) isolate exception
roundtrip, unaligned LDM rejection, IRQ masks and true/false IT slots, and stale
state after a final conditional RAM access at a budget boundary. These small
probes make CPU-engine defects distinguishable from board-model defects.

## Follow firmware-visible transactions

The [architecture](architecture.md) places the actual firmware CPU between the
host MIDI session and peripherals. A module worker executes the machine; the
panel and updater share that machine. Only the explicitly labeled DemoSession
synthesizes host-level protocol replies.

USB bring-up required reset recovery and setup traffic even when ENUMDNE remained
masked, soft-disconnect handling, visible SOF/idle IN polling, and OUT data followed
by completion. USB-MIDI cable directions are asymmetric: host-to-device uses 2,
device-to-host 1. [USB tests](../web/tests/usb.test.js) preserve these observations
and reject malformed nonzero packets while accepting zero padding.

Panel compatibility depended on scan causality. Six-byte startup SPI samples the
previous selected row at the latch; eight-byte DMA scans preserve the leading
serial clocks and next-row selection. GLOBAL and GLOBAL+PATTERN therefore enter
Version/Update through inputs. The [panel contract](panel-interface.md) and
[tests](../web/tests/panel.test.js) cover 85 unique switches, six quadrature
encoders, PWM-derived LEDs, and independent trigger latching. The display decodes
8192 DMA bytes into 256×64 four-bit pixels. Output indicators observe configured
SAI/DMA/GPIO paths, not application RAM guesses.

[Board tests](../web/tests/board.test.js) make DMA completion depend on configured
SPI clock spacing and preserve APB/TIMPRE timer behavior. Known passive register
storage remains a documented approximation; identifiable unknown peripheral
accesses stop execution. This is a bounded board contract, not a complete
STM32/electrical simulation.

## Separate interactive usability from physical timing evidence

Private dispatch observations recorded in [coverage](coverage.md) found rapid
browser detents causing firmware acceleration. Interactive input now spaces
detents and retains button edges for 40 ms of virtual time. That solves GUI
interaction; it does not validate electrical debounce or encoder timing.

Commit `3d0f538` adds raw `encoder-lines` and `panel-bit` inputs plus cycle-timed
replay. The [fidelity tests](../web/tests/fidelity.test.js) demonstrate bypassing
named wiring and scan pacing, retaining ordered edges, and reporting rounding to
the next instruction boundary. Use a fresh machine per timing arm, preserve the
cycles-per-instruction ratio, and compare raw captures separately from normalized
UI input. Nominal 216 MHz and the default 16 cycles per instruction do not make
execution cycle accurate.

## Prove storage and updates at their real boundaries

Sixteen MiB of SPI NOR is necessary to represent saved slot 63. The flash model
needs CS-delimited page latches, WEL/WIP, page wrap, NOR bit clearing, and rejected
busy writes. Commit `3d0f538` defers program/erase until virtual deadlines and
discards unfinished operations on power cut. The fidelity tests exercise those
states; timing parameters remain uncalibrated and torn bits are unmodeled.

A restore ACK only acknowledges receipt. Recorded private tests found abrupt
reset could lose workspace/catalog metadata despite retained project bytes.
Persistence testing therefore holds the active-low power input, waits for
firmware to release power hold, cold-starts, and compares a fresh backup,
including populated first and last slots.

Updates require a selected-candidate context, not a boot-mode exemption.
[Installation tests](../web/tests/installation.test.js) require exact begin and
all 224 ordered packets before expected erases and candidate-matching writes are
allowed. Mismatched bytes fault before mutation; option writes, mass erase,
unsafe DMA and unknown commands remain blocked. Reset/replacement revokes the
context. Cancellation after complete submission permits already-started
programming; new MIDI traffic expires authorization. Firmware still executes
the writes. Reports distinguish boot-image and installation-candidate hashes.
The native backend retains unconditional flash protection.

## Preserve evidence while improving performance

Public history records the bridge/panel changes in `0dba002`, updater addition
in `6f8ee8b`, and delayed flash/raw replay in `3d0f538`. Scalar execution remains
a comparison baseline. Recorded private performance comparisons check registers,
memory and IRQ state at instruction checkpoints; public WASM probes compare
scalar/bridge behavior across uneven instruction budgets. Faster host scheduling
must preserve guest-visible deadlines.

The sibling contract documents a browser translation-block budget that can trap
on long straight-line compiled code. Its approximate 80-instruction working
margin is an engine workaround, not a hardware obligation. Native and browser
coverage are separate: [coverage](coverage.md) records private stock 2.03/custom
2.04 acceptance, including USB, inputs, installation and shutdown persistence,
but explicitly limits those findings. The public original ARM integration probe
establishes synthetic protocol/staging behavior, not stock compatibility.

## Fresh checks for this reconstruction

On 2026-10-20, Node 24.17.0 passed 27 focused peripheral/input/installation tests
and four directed WASM CPU tests. From `web/`:

```sh
node --test --test-isolation=none tests/fidelity.test.js tests/panel.test.js tests/usb.test.js tests/board.test.js tests/installation.test.js
node --test --test-isolation=none --test-name-pattern='WASM executes|Cortex-M interrupt|native bridge preserves|last conditional RAM' tests/wasm.test.js
```

These fresh checks use original synthetic fixtures. No long boot, complete
browser suite, private candidate run, hardware access, or firmware flashing was
performed. The reusable method is to bind image identity, reproduce failures
with small probes, observe firmware through peripheral boundaries, separate raw
captures from UI policy, and state exactly which candidate and execution path
support each compatibility claim.
