.syntax unified
.cpu cortex-m7
.thumb
.global _start
_start:
 ldr r0, =0x40020418
 movs r1, #128
 str r1, [r0]
 ldr r2, =0x40020810
 movw r3, #8192
poll:
 ldr r1, [r2]
 tst r1, r3
 bne poll
 mov.w r1, #0x800000
 str r1, [r0]
 b .
 .ltorg
