/* SPDX-License-Identifier: GPL-2.0-only */
static uint64_t timer_period(SQ64State *s, uint32_t base)
{
    unsigned prescaler = (reg_get(s, 0x40023808) >> (base >= 0x40010000 ? 13 : 10)) & 7;
    unsigned apb = prescaler < 4 ? 1 : 1 << (prescaler - 3);
    unsigned divider = MAX(1, apb / ((reg_get(s, 0x4002388c) & 0x1000000) ? 4 : 2));
    return ((uint64_t)reg_get(s, base + 0x28) + 1) * divider;
}
static void timer_sync(SQTimer *t)
{
    SQ64State *s = t->board; uint64_t now = sq_cycles(s), elapsed = now - t->epoch;
    t->epoch = now;
    if (s->fault || !(reg_get(s, t->base) & 1)) { timer_del(t->timer); return; }
    uint64_t period = timer_period(s, t->base), total = t->fraction + elapsed;
    uint64_t increment = total / period, reload = (uint64_t)reg_get(s, t->base + 0x2c) + 1;
    t->fraction = total % period;
    if (reload == 1) { reload = 65536; }
    uint64_t count = reg_get(s, t->base + 0x24) + increment;
    if (count >= reload) {
        uint32_t status = reg_get(s, t->base + 0x10); reg_put(s, t->base + 0x10, status | 1);
        if ((reg_get(s, t->base + 12) & 1) && !(status & 1)) { pend(s, t->irq); }
    }
    count %= reload; reg_put(s, t->base + 0x24, count);
    uint64_t delay = (reload - count) * period - t->fraction;
    timer_mod(t->timer, qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL) + MAX(1, (delay + 15) / 16));
}
static void sq_timer_expired(void *opaque) { timer_sync(opaque); }
static void timers_sync(SQ64State *s)
{
    for (unsigned i = 0; i < ARRAY_SIZE(s->timers); i++) { timer_sync(&s->timers[i]); }
}
static bool known_peripheral(SQ64State *s, uint32_t address, unsigned n)
{
    static const uint32_t ranges[][2] = {{0x40003800,0x800}, {0x40004400,0x800},
        {0x40007000,0x800}, {0x40010000,0x100}, {0x40012000,0x400},
        {0x40013000,0x5000}, {0x40020000,0x2400}, {0x40023800,0x800}, {0x40026000,0x800}};
    for (unsigned i = 0; i < ARRAY_SIZE(ranges); i++) {
        if (address >= ranges[i][0] && (uint64_t)address + n <= (uint64_t)ranges[i][0] + ranges[i][1]) { return true; }
    }
    for (unsigned i = 0; i < ARRAY_SIZE(s->timers); i++) {
        if (address >= s->timers[i].base && (uint64_t)address + n <= s->timers[i].base + 0x80) { return true; }
    }
    return false;
}
static uint64_t peripheral_read(void *opaque, hwaddr offset, unsigned n)
{
    SQ64State *s = opaque; uint32_t a = 0x40000000 + offset, value = 0;
    if (!known_peripheral(s, a, n)) {
        sq_fault(s, 0, "unmodeled-peripheral-read", a, n, 0, "cpu"); return 0;
    }
    timers_sync(s); spi_advance(s);
    if (a == 0x40020810) { reg_put(s, a, (reg_get(s, a) & ~8192) | (s->power_button ? 0 : 8192)); }
    if (a == 0x40020410) { reg_put(s, a, (reg_get(s, a) & ~16) | (s->sync_connected ? 0 : 16)); }
    if (a == 0x40020010) { reg_put(s, a, reg_get(s, a) | 512); }
    if (a == 0x40023800) {
        value = reg_get(s, a);
        const unsigned bits[] = {0,16,24,26};
        for (unsigned i = 0; i < ARRAY_SIZE(bits); i++) { if (value & (1U << bits[i])) { value |= 1U << (bits[i] + 1); } }
        reg_put(s, a, value);
    }
    if (a == 0x40023808) { value = reg_get(s, a); reg_put(s, a, (value & ~12) | ((value & 3) << 2)); }
    if (a == 0x40007004) { reg_put(s, a, reg_get(s, a) | 0x4000); }
    if (a == 0x40012000 && (reg_get(s, 0x40012008) & 0x40000000)) {
        reg_put(s, 0x4001204c, s->adc_sample); reg_put(s, 0x40012008, reg_get(s, 0x40012008) & ~0x40000000);
        reg_put(s, a, reg_get(s, a) | 2);
    }
    if (a == 0x40003808) { dma_complete(s); return 2 | (s->spi_rx.count ? 512 : 0); }
    if (a == 0x4000380c) {
        if (s->spi_rx.count < n) { sq_fault(s, 0, "flash-fifo-underflow", a, n, 0, "spi"); return 0; }
        for (unsigned i = 0; i < n; i++) { value = (value << 8) | queue_pop(s, &s->spi_rx); } return value;
    }
    if (a == 0x40013008) { return 2 | (s->panel_in.count ? 512 : 0); }
    if (a == 0x4001300c) {
        if (n != 1) { sq_fault(s, 0, "panel-fifo-width", a, n, 0, "panel"); return 0; }
        return queue_pop(s, &s->panel_in);
    }
    if (a == 0x40003c08) { return 2; }
    if (a == 0x40013c14) { reg_put(s, a, reg_get(s, a) | 4); }
    if (a == 0x40023c0c) { return 0; }
    if (a == 0x40023c10) { return s->flash_control; }
    for (unsigned i = 0; i < 2; i++) {
        uint32_t base = 0x40004400 + i * 0x400;
        if (a == base) { return 192 | (s->din_rx[i].count ? 32 : 0); }
        if (a == base + 4) {
            value = queue_pop(s, &s->din_rx[i]);
            if (s->din_rx[i].count && (reg_get(s, base + 12) & 32)) { pend(s, 38 + i); }
            return value;
        }
    }
    if (a >= 0x40026000 && a < 0x40026800) { dma_complete(s); }
    value = 0; for (unsigned i = 0; i < n; i++) { value |= s->registers[offset + i] << (8 * i); }
    return value;
}
static void peripheral_write(void *opaque, hwaddr offset, uint64_t value, unsigned n)
{
    SQ64State *s = opaque; uint32_t a = 0x40000000 + offset;
    if (critical_memory(s, a, n, value, true, "cpu") || !dma_guard(s, a, n, value)) { return; }
    if (!known_peripheral(s, a, n)) {
        sq_fault(s, 0, "unmodeled-peripheral-write", a, n, value, "cpu"); return;
    }
    timers_sync(s);
    if (a == 0x40023c04) {
        if (s->flash_key == 0x45670123 && value == 0xcdef89ab) { s->flash_control &= ~0x80000000; }
        s->flash_key = value;
    }
    if (a == 0x40023c10) { s->flash_control = value; }
    if (a == 0x40020418 && (value & 0x800000) && (reg_get(s, 0x40020414) & 128)) {
        spi_advance(s); s->spi_operation = 0; s->selected = s->write_enable = false; s->powered_off = true;
        vm_stop(RUN_STATE_SHUTDOWN);
    }
    for (uint32_t base = 0x40020000; base < 0x40022400; base += 1024) {
        if (a == base + 24) { reg_put(s, base + 20, (reg_get(s, base + 20) | (value & 65535)) & ~(value >> 16)); }
    }
    if (a == 0x40020418) {
        if (value & 0x2000000) { spi_select(s, true); }
        if (value & 512) { spi_select(s, false); }
        if (value & 0x10000) { panel_latch(s, false); }
        if (value & 1) { panel_latch(s, true); }
    }
    if (a == 0x4000380c) {
        if (n != 1 && n != 2) { sq_fault(s, 0, "spi-word-width", a, n, value, "spi"); return; }
        for (unsigned i = n; i; i--) { queue_push(s, &s->spi_rx, spi_exchange(s, value >> (8 * (i - 1)))); }
    }
    if (a == 0x4001300c) {
        if (n != 1) { sq_fault(s, 0, "panel-polled-width", a, n, value, "panel"); return; }
        queue_push(s, &s->panel_in, panel_exchange(s, value));
    }
    for (unsigned i = 0; i < 2; i++) { if (a == 0x40004404 + i * 0x400) { midi_emit(s, value, i, 0); } }
    for (unsigned controller = 0; controller < 2; controller++) {
        uint32_t block = 0x40026000 + controller * 0x400;
        if (a == block + 8 || a == block + 12) { reg_put(s, a - 8, reg_get(s, a - 8) & ~value); }
        for (unsigned stream = 0; stream < 8; stream++) {
            uint32_t base = block + 16 + stream * 24;
            if (a == base + 4) { s->dma_reload[controller * 8 + stream] = value; }
            if (a == base && (value & 1) && !(reg_get(s, base) & 1)) { reg_put(s, base + 4, s->dma_reload[controller * 8 + stream]); }
        }
    }
    for (unsigned i = 0; i < n; i++) { s->registers[offset + i] = value >> (i * 8); }
    timers_sync(s);
}
static const MemoryRegionOps peripheral_ops = {
    .read = peripheral_read, .write = peripheral_write, .endianness = DEVICE_LITTLE_ENDIAN,
    .valid = {.min_access_size = 1, .max_access_size = 4, .unaligned = true},
    .impl = {.min_access_size = 1, .max_access_size = 4, .unaligned = true},
};
static void service_tick(void *opaque)
{
    SQ64State *s = opaque;
    if (s->fault || s->powered_off) { return; }
    spi_advance(s); dma_complete(s); usb_service(s);
    timer_mod(s->service, qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL) + 128);
}
static void quantum_end(void *opaque)
{
    SQ64State *s = opaque; s->runs++; vm_stop(RUN_STATE_PAUSED);
}
