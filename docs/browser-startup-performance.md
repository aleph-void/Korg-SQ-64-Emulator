# Browser startup timing

The normal USB boot uses three modeled core cycles per instruction until USB configuration completes, then returns to sixteen. Version mode, Update mode and the DIN integration probe use sixteen throughout. This is a browser execution policy, not cycle-accurate Cortex-M7 timing.

At the old sixteen-cycle rate, a display redraw during the pad sweep spans multiple firmware timer ticks. The firmware advances its animation once per observed tick change, so it loses animation steps during redraws. This becomes visible near column 6. The finer startup clock reduces those missed steps; restoring the interactive clock preserves the existing button debounce and encoder spacing.

To offset the extra startup instructions, the WASM build uses link-time optimization, a compact Thumb hook operation and early native memory-hook filtering. DMA polling skips idle boundaries while retaining the same 128-instruction completion boundaries and waking after register or clock changes. USB polling keeps its existing cadence once connected.

Local Chrome measurements with caller-owned stock 2.03, before/after:

| Measurement | Before | After |
| --- | ---: | ---: |
| Load to configured USB | 27.7 s | 27.4 s |
| Sweep cadence before column 6 | about 0.13 s/column | about 0.24 s/column |
| Sweep cadence after column 6 | about 0.62 s/column | about 0.33 s/column |
| Single encoder event through scheduled dwell | 110 ms | 110 ms |

The sharp slowdown is substantially reduced; the sweep is not perfectly uniform. Times depend on the browser and host. These measurements do not establish hardware timing or behavior for arbitrary firmware, especially firmware that configures USB at a different startup stage.

At unchanged sixteen-cycle timing, a 210-million-instruction stock trace matched the previous engine's CPU registers, RAM, peripherals, interrupt reports and panel snapshots at every million instructions, with a roughly 1.6x throughput gain. Public regression probes cover instruction budgets, interrupts, conditional RAM accesses, debugger switching, alignment faults and DMA completion timing. Vendor firmware and private traces are not distributed.
