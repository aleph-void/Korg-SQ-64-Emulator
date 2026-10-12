# Browser panel interface

The browser model is independently implemented host code. The tables below are interface facts; this project distributes no vendor firmware, decompiled functions, original lookup-table bytes, display assets, or private captures. Private execution checks observe supplied firmware consuming the signals, without replacing its functions or writing its application RAM.

## Inputs

Eight row selects multiplex active-high button inputs. Each row has a 32-bit parallel value; encoder lines occupy bits 4–15 and are shared across rows. The following named controls occupy `(row, bit)`:

| Control | Row | Bit |
| --- | ---: | ---: |
| TAP / STOP | 0 | 0 / 1 |
| RECORD / PLAY | 1 | 0 / 1 |
| CONTROL | 0 | 18 |
| Track A / B | 0 | 17 / 16 |
| Track C / D | 1 | 18 / 17 |
| GATE / PITCH | 2 | 18 / 17 |
| MOD / LOOP | 3 | 18 / 17 |
| Bar 1 / 2 | 4 | 18 / 17 |
| Bar 3 / 4 | 5 | 18 / 17 |
| GLOBAL / PROJECT | 6 | 18 / 17 |
| PATTERN / SHIFT | 7 | 18 / 17 |

Pad `n` (1–16) uses row `(n−1) mod 8`. First/second banks use bits A:26/24, B:25/23, C:22/20, D:21/19. Together these give 85 distinct switches.

The six encoders, in UI order, occupy two bits each starting at bit 4. A positive turn follows Gray phases `00 → 01 → 11 → 10 → 00`; each UI detent queues two edges. Direction reversals retain their order. Edges are paced across scan-row changes so firmware can observe them. Debouncing and acceleration remain firmware responsibilities.

## Serial scans

A DMA frame has eight bytes. Its first 15 serial clocks precede the 32 sampled input bits. The input bits are serialized in byte order from the low byte, with bits transmitted most significant first within each byte. TX byte 2 supplies the one-hot row select. The next scan samples that selected row.

Startup uses six-byte polled SPI frames with the row select in TX byte 0. GPIO B0 falling samples the previously selected inputs; its rising edge latches the new row. The six-byte receive stream omits the two leading DMA bytes. This produces the two-frame pipeline used by startup scanning. GLOBAL and PATTERN therefore enter firmware through the same electrical map in startup and normal operation; no host-side mode switch or application-memory patch implements the chords.

## LEDs and display

TX bytes 5, 4 and the low five bits of byte 3 drive 21 LED columns. The model integrates duty cycle until the row changes. Paired even/odd rows provide two LED channels per control; the UI currently shows lit/unlit styling from the brighter channel using the site's accent color. Transport LEDs use active-low auxiliary bits 2–5 in byte 7 on rows 0 and 1. Colorimetry and electrical PWM timing are not calibrated.

Pad columns are 1–16, with track selectors at column 0; tracks A/B/C/D use row pairs 0/1, 2/3, 4/5 and 6/7. Named controls use the remaining columns, independently of their input wiring. Pressed styling is separate from firmware-driven LED state.

The display decoder consumes 8192 DMA bytes as 256×64 grayscale pixels, low nibble first and bottom row first. It does not reproduce all display-controller commands.

## Power button and shutdown

The power button is an active-low GPIO C13 input, separate from the scan matrix. Firmware keeps power latched through GPIO B7 and releases that output after its shutdown work. The model stops CPU execution only after an asserted power-hold output is released; pressing the input alone does not stop execution.

**Power off** holds the input while firmware runs its save sequence. Wait for **Powered off** before using Power on, Version or Update. Those startup controls perform an immediate reset. Closing or reloading the page discards the in-memory emulator session, including flash storage.

A restore ACK does not mean the current workspace and saved-project catalog are durable. Private stock/custom checks found that abrupt reset can lose this metadata even while the saved project bytes remain in SPI. Normal power-button shutdown is required before a restart persistence check.

## Evidence boundary

Private stock 2.03 and custom 2.04 runs verify all 85 button presses/releases and both directions of all six encoders at firmware dispatch, plus actual Version/Update startup and rendered screens. These checks establish software interaction for those images. The model is not a cycle-accurate or electrical simulator and does not certify arbitrary firmware for hardware.
