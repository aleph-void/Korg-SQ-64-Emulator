/* Original test probe: program one byte at SPI flash 0x40000 (project area),
 * then idle. Used to verify that Restore firmware discards emulated flash. */
.syntax unified
.cpu cortex-m7
.thumb
.global _start
_start:
 ldr r0, =0x40020418
 ldr r1, =0x4000380c
 ldr r2, =0x02000000
 ldr r3, =0x00000200
 str r2, [r0]
 movs r4, #6
 strb r4, [r1]
 str r3, [r0]
 str r2, [r0]
 movs r4, #2
 strb r4, [r1]
 movs r4, #4
 strb r4, [r1]
 movs r4, #0
 strb r4, [r1]
 strb r4, [r1]
 strb r4, [r1]
 str r3, [r0]
 b .
 .ltorg
