/* SPDX-License-Identifier: GPL-2.0-only */
static bool dma_memory(SQ64State *s, uint32_t address, void *buffer, unsigned length, bool write)
{
    if ((uint64_t)address + length > UINT32_MAX + 1ULL) {
        sq_fault(s, 5, "dma-address-wrap", address, length, 0, "dma");
        return false;
    }
    if (write && critical_memory(s, address, length, 0, false, "dma")) { return false; }
    if (address_space_rw(&address_space_memory, address, MEMTXATTRS_UNSPECIFIED,
                         buffer, length, write) != MEMTX_OK) {
        sq_fault(s, 0, "dma-unmapped-memory", address, length, 0, "dma");
        return false;
    }
    return !s->fault;
}
static uint32_t dma_overlay(SQ64State *s, uint32_t address, uint32_t write_address,
                            unsigned size, uint64_t data)
{
    uint32_t value = reg_get(s, address);
    for (unsigned i = 0; i < 4; i++) {
        if (write_address <= address + i && address + i < (uint64_t)write_address + size) {
            value = (value & ~(255U << (8 * i))) |
                    (((data >> (8 * (address + i - write_address))) & 255) << (8 * i));
        }
    }
    return value;
}
static bool dma_guard(SQ64State *s, uint32_t address, unsigned size, uint64_t value)
{
    for (unsigned controller = 0; controller < 2; controller++) {
        for (unsigned stream = 0; stream < 8; stream++) {
            uint32_t base = 0x40026010 + controller * 0x400 + stream * 24;
            uint32_t c = dma_overlay(s, base, address, size, value);
            if (!(c & 1)) { continue; }
            bool peripheral = ((c >> 6) & 3) == 1;
            unsigned width = 1U << ((c >> (peripheral ? 11 : 13)) & 3);
            unsigned count = MAX(1, dma_overlay(s, base + 4, address, size, value) & 65535);
            uint64_t length = (c & (peripheral ? 512 : 1024)) ? (uint64_t)count * width : width;
            unsigned first = peripheral ? 8 : 12;
            unsigned last = !peripheral && (c & 0x40000) ? 16 : first;
            for (unsigned offset = first; offset <= last; offset += 4) {
                uint32_t a = dma_overlay(s, base + offset, address, size, value);
                if ((uint64_t)a + length > UINT32_MAX + 1ULL) {
                    sq_fault(s, 5, "dma-address-wrap", a, length, 0, "dma");
                    return false;
                }
                if (critical_memory(s, a, length, 0, false, "dma")) { return false; }
            }
        }
    }
    return true;
}
static void dma_done(SQ64State *s, unsigned controller, unsigned stream, uint32_t control)
{
    static const unsigned irqs[2][8] = {{11,12,13,14,15,16,17,47}, {56,57,58,59,60,68,69,70}};
    static const unsigned shifts[] = {0,6,16,22};
    uint32_t base = 0x40026010 + controller * 0x400 + stream * 24;
    uint32_t status = 0x40026000 + controller * 0x400 + (stream >= 4 ? 4 : 0);
    reg_put(s, base, control & ~1U);
    reg_put(s, base + 4, 0);
    reg_put(s, status, reg_get(s, status) | (1U << (shifts[stream % 4] + 5)));
    if (control & 16) { pend(s, irqs[controller][stream]); }
}
static void dma_complete(SQ64State *s)
{
    if (s->fault || !dma_guard(s, 0, 0, 0)) { return; }
    int tx = -1, rx = -1;
    uint32_t tc = 0, rc = 0;
    for (unsigned i = 0; i < 8; i++) {
        uint32_t base = 0x40026010 + i * 24, c = reg_get(s, base);
        if (!(c & 1) || reg_get(s, base + 8) != 0x4000380c) { continue; }
        if (((c >> 6) & 3) == 1 && tx < 0) { tx = i; tc = c; }
        if (((c >> 6) & 3) == 0 && rx < 0) { rx = i; rc = c; }
    }
    if (tx >= 0 && rx >= 0) {
        uint32_t tb = 0x40026010 + tx * 24, rb = 0x40026010 + rx * 24;
        unsigned count = reg_get(s, tb + 4), width = 1U << ((tc >> 13) & 3);
        if (!count || count > 4096 || count != reg_get(s, rb + 4) || width > 2 ||
            width != (1U << ((rc >> 13) & 3))) {
            sq_fault(s, 0, "unsupported-flash-dma-geometry", tb, 4, count, "dma");
            return;
        }
        uint32_t source = reg_get(s, tb + 12), target = reg_get(s, rb + 12);
        for (unsigned i = 0; i < count; i++) {
            uint8_t input[2], output[2];
            if (!dma_memory(s, source + ((tc & 1024) ? i * width : 0), input, width, false)) { return; }
            for (unsigned j = 0; j < width; j++) {
                output[width - j - 1] = spi_exchange(s, input[width - j - 1]);
                if (s->fault) { return; }
            }
            if (!dma_memory(s, target + ((rc & 1024) ? i * width : 0), output, width, true)) { return; }
        }
        dma_done(s, 0, tx, tc); dma_done(s, 0, rx, rc);
    }
    uint32_t base = 0x40026088, control = reg_get(s, base);
    if ((control & 1) && reg_get(s, base + 8) == 0x40003c0c) {
        unsigned count = reg_get(s, base + 4), width = 1U << ((control >> 13) & 3);
        if (((control >> 6) & 3) != 1 || width != 2 || !(control & 1024) || count != 4096) {
            sq_fault(s, 0, "unsupported-display-dma-geometry", base, 4, count, "dma");
            return;
        }
        if (!dma_memory(s, reg_get(s, base + 12), s->display, sizeof(s->display), false)) { return; }
        s->display_frames++; dma_done(s, 0, 5, control);
    }
    uint32_t tb = 0x40026458, rb = 0x40026440;
    tc = reg_get(s, tb); rc = reg_get(s, rb);
    if ((tc & 1) && (rc & 1) && reg_get(s, tb + 8) == 0x4001300c && reg_get(s, rb + 8) == 0x4001300c &&
        sq_cycles(s) - s->panel_last_cycle >= panel_transfer_cycles(s)) {
        if (!(tc & 256) || !(rc & 256) || ((tc >> 6) & 3) != 1 || ((rc >> 6) & 3) || ((tc | rc) & 0x7800)) {
            sq_fault(s, 0, "unsupported-panel-dma-configuration", tb, 4, tc, "dma");
            return;
        }
        unsigned count = reg_get(s, tb + 4);
        if ((count != 64 && count != 128) || reg_get(s, rb + 4) != count) {
            sq_fault(s, 0, "unsupported-panel-dma-length", tb, 4, count, "dma");
            return;
        }
        unsigned offset = 128 - count;
        uint32_t source = reg_get(s, tb + 12) + offset, target = reg_get(s, rb + 12) + offset;
        for (unsigned i = 0; i < 64; i += 8) {
            uint8_t input[8], output[8];
            if (!dma_memory(s, source + i, input, 8, false)) { return; }
            panel_scan(s, input, output);
            if (!dma_memory(s, target + i, output, 8, true)) { return; }
        }
        unsigned remaining = count == 128 ? 64 : 128;
        reg_put(s, tb + 4, remaining); reg_put(s, rb + 4, remaining);
        unsigned flag = 1U << (count == 128 ? 26 : 27);
        reg_put(s, 0x40026400, reg_get(s, 0x40026400) | flag);
        if (tc & (count == 128 ? 8 : 16)) { pend(s, 59); }
        s->panel_last_cycle = sq_cycles(s);
    }
}
