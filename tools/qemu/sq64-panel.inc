/* SPDX-License-Identifier: GPL-2.0-only */
static void panel_input(SQ64State *s, unsigned row, uint8_t out[8])
{
    static const unsigned bits[] = {4,6,12,14,8,10}, gray[] = {0,1,3,2};
    uint32_t value = s->panel_bits[row];
    for (unsigned i = 0; i < 6; i++) { value |= gray[s->encoder_phase[i]] << bits[i]; }
    value = (value & ~s->panel_masks[row]) | s->panel_raw[row];
    uint8_t b[4]; stl_le_p(b, value);
    out[0] = out[6] = out[7] = 0;
    out[1] = b[0] >> 7; out[2] = (b[0] << 1) | (b[1] >> 7);
    out[3] = (b[1] << 1) | (b[2] >> 7); out[4] = (b[2] << 1) | (b[3] >> 7); out[5] = b[3] << 1;
}
static void panel_latch(SQ64State *s, bool high)
{
    if (!high) {
        uint8_t data[8]; panel_input(s, s->panel_selected, data); memcpy(s->panel_shift_rx, data + 2, 6);
    } else {
        unsigned mask = s->panel_shift_count ? s->panel_shift[0] : 0;
        if (mask && !(mask & (mask - 1))) { s->panel_selected = ctz32(mask); }
        if (s->panel_shift_count == 6) { s->triggers = ~s->panel_shift[4] & 255; }
        s->panel_shift_count = 0;
    }
}
static uint8_t panel_exchange(SQ64State *s, uint8_t value)
{
    if (s->panel_shift_count >= 6) {
        sq_fault(s, 0, "panel-latch-required", 0x4001300c, 1, value, "panel"); return 0;
    }
    unsigned index = s->panel_shift_count++; s->panel_shift[index] = value;
    return s->panel_shift_rx[index];
}
static void panel_scan(SQ64State *s, const uint8_t *tx, uint8_t *rx)
{
    if (s->panel_mapping) { rx[0] = rx[1] = 255; memcpy(rx + 2, s->panel_rx + s->scan_row * 6, 6); }
    else { panel_input(s, s->scan_row, rx); }
    unsigned mask = tx[2];
    if (mask && !(mask & (mask - 1))) {
        unsigned row = ctz32(mask); s->triggers = ~tx[6] & 255;
        if (row != s->scan_row) {
            for (unsigned i = 0; i < 6; i++) {
                if (s->encoder_edges[i].count) {
                    int edge = (int8_t)queue_pop(s, &s->encoder_edges[i]);
                    s->encoder_phase[i] = (s->encoder_phase[i] + edge + 4) % 4;
                }
            }
        }
        s->scan_row = row;
        if (row != s->led_row && s->led_samples) {
            for (unsigned i = 0; i < 32; i++) {
                s->led_rows[s->led_row][i] = (s->led_counts[i] * 255ULL + s->led_samples / 2) / s->led_samples;
            }
            memset(s->led_counts, 0, sizeof(s->led_counts)); s->led_samples = 0; s->led_row = row;
        }
        uint32_t bits = tx[5] | (tx[4] << 8) | ((tx[3] & 31) << 16) | (((~tx[7] & 60U) >> 2) << 28);
        for (unsigned i = 0; i < 32; i++) { if (bits & (1U << i)) { s->led_counts[i]++; } }
        s->led_samples++;
    }
}
static uint64_t panel_transfer_cycles(SQ64State *s)
{
    unsigned apb = (reg_get(s, 0x40023808) >> 13) & 7;
    unsigned divider = apb < 4 ? 1 : 1 << (apb - 3);
    return 512ULL * divider * (2 << ((reg_get(s, 0x40013000) >> 3) & 7));
}
