/* Original diagnostic firmware for emulator tests. NOT a deployable SQ-64 image.
 * It deliberately omits a hardware updater, loader, calibration and persistence.
 */
#include <stdint.h>
#define REG(a) (*(volatile uint32_t *)(a))
#define BYTE(a) (*(volatile uint8_t *)(a))
static uint16_t pixels[4096];
volatile uint32_t received, timer_interrupts;
void timer_irq(void) { REG(0x40001410) = 0; ++timer_interrupts; }
void reset(void) {
    REG(0x40026090) = 0x40003c0c;
    REG(0x40026094) = (uint32_t)pixels;
    REG(0x40001428) = 63;
    REG(0x4000142c) = 4095;
    REG(0x4000140c) = 1;
    REG(0xe000e104) = 1u << (55 - 32);
    REG(0x40001400) = 1;
    uint32_t phase = 0;
    for (;;) {
        BYTE(0x4001300c) = 0;
        uint8_t keys = BYTE(0x4001300c);
        for (uint32_t i = 0; i < 4096; ++i) {
            uint8_t level = (uint8_t)((i / 128 + phase + (keys != 255 ? 8 : 0)) & 15);
            pixels[i] = (uint16_t)(level * 0x1111);
        }
        REG(0x4002608c) = 4096;
        REG(0x40026088) = 0x22441;
        while (REG(0x40026088) & 1) {}
        if (REG(0x40004800) & 0x20) { received = BYTE(0x40004804); BYTE(0x40004804) = (uint8_t)received; }
        ++phase;
    }
}
__attribute__((section(".vectors"), used))
const uintptr_t vectors[96] = {[0] = 0x20040000, [1] = (uintptr_t)reset, [71] = (uintptr_t)timer_irq};
