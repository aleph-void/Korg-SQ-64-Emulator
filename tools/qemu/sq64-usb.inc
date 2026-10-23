/* SPDX-License-Identifier: GPL-2.0-only
 * Device-controller registers plus an external USB host transaction sequencer.
 * Descriptor bytes, endpoint traffic and MIDI responses are produced by guest code.
 */
static void midi_emit(SQ64State *s, uint8_t byte, unsigned port, unsigned cable)
{
    if (s->midi_output.count + 3 > QUEUE_SIZE) {
        for (unsigned i = 0; i < 3; i++) { queue_pop(s, &s->midi_output); }
    }
    queue_push(s, &s->midi_output, port); queue_push(s, &s->midi_output, cable);
    queue_push(s, &s->midi_output, byte);
}
static uint32_t usb_reg(SQ64State *s, unsigned o) { return s->usb_regs[o / 4]; }
static uint32_t usb_in_status(SQ64State *s, unsigned ep)
{
    return s->usb_in[ep] | ((s->usb_expect[ep] && s->usb_expected[ep] > s->usb_tx_count[ep]) ? 128 : 0);
}
static uint32_t usb_status(SQ64State *s)
{
    uint32_t v = s->usb_global | (s->usb_rx_count ? 16 : 0);
    for (unsigned ep = 0; ep < 6; ep++) {
        if ((usb_reg(s, 0x81c) & (1 << ep)) && (usb_in_status(s, ep) &
             (usb_reg(s, 0x810) | ((usb_reg(s, 0x834) & (1 << ep)) ? 128 : 0)))) { v |= 1 << 18; }
        if ((usb_reg(s, 0x81c) & (1 << (16 + ep))) && (s->usb_out[ep] & usb_reg(s, 0x814))) { v |= 1 << 19; }
    }
    return v;
}
static void usb_signal(SQ64State *s)
{
    if ((usb_reg(s, 8) & 1) && (usb_status(s) & usb_reg(s, 0x18))) { pend(s, 67); }
}
static void usb_receive(SQ64State *s, unsigned ep, unsigned kind, const uint8_t *data, unsigned n)
{
    if (s->usb_rx_count == ARRAY_SIZE(s->usb_rx) || n > 64 || ep >= 6) {
        sq_fault(s, 0, "usb-receive-overflow", ep, n, kind, "usb"); return;
    }
    unsigned i = (s->usb_rx_head + s->usb_rx_count++) % ARRAY_SIZE(s->usb_rx);
    s->usb_rx[i].ep = ep; s->usb_rx[i].kind = kind; s->usb_rx[i].size = n;
    if (n) { memcpy(s->usb_rx[i].bytes, data, n); }
}
static void usb_setup(SQ64State *s, const uint8_t data[8])
{
    memcpy(s->usb_setup, data, 8); s->usb_setup_active = true;
    usb_receive(s, 0, 6, data, 8); usb_receive(s, 0, 4, NULL, 0);
    s->usb_out[0] |= 8; usb_signal(s);
}
static void usb_finish_in(SQ64State *s, unsigned ep)
{
    unsigned n = MIN(s->usb_tx_count[ep], s->usb_expected[ep]);
    uint8_t *data = s->usb_tx[ep]; s->usb_in[ep] |= 1;
    if (!ep) {
        bool complete = true;
        if (s->usb_setup_active && s->usb_setup[1] == 6 && s->usb_setup[3] == 2) {
            if (s->usb_config_count + n > sizeof(s->usb_config)) {
                sq_fault(s, 0, "usb-descriptor-overflow", ep, n, 0, "usb"); return;
            }
            memcpy(s->usb_config + s->usb_config_count, data, n); s->usb_config_count += n;
            unsigned expected = lduw_le_p(s->usb_setup + 6);
            if (s->usb_config_count >= 4) { expected = MIN(expected, lduw_le_p(s->usb_config + 2)); }
            complete = n < 64 || s->usb_config_count >= expected;
        }
        if (complete && s->usb_setup_active && (s->usb_setup[0] & 128)) {
            usb_receive(s, 0, 2, NULL, 0); usb_receive(s, 0, 3, NULL, 0); s->usb_out[0] |= 1;
        }
        if (complete) { s->usb_setup_active = false; }
    } else {
        static const unsigned lengths[] = {0,0,2,3,3,1,2,3,3,3,3,3,2,2,3,1};
        if (n % 4) { sq_fault(s, 0, "usb-midi-alignment", ep, n, 0, "usb"); return; }
        for (unsigned i = 0; i < n; i += 4) {
            unsigned count = lengths[data[i] & 15], cable = data[i] >> 4;
            for (unsigned j = 0; j < count; j++) { midi_emit(s, data[i + j + 1], 2, cable); }
        }
    }
    s->usb_tx_count[ep] = 0; s->usb_expected[ep] = 0; s->usb_expect[ep] = false; usb_signal(s);
}
static uint64_t usb_read(void *opaque, hwaddr o, unsigned size)
{
    SQ64State *s = opaque;
    if (size != 4 || o % 4 || o >= 0x6000) {
        sq_fault(s, 0, "usb-word-access-required", 0x50000000 + o, size, 0, "cpu"); return 0;
    }
    if (o == 0x10) { return 0x80000000; }
    if (o == 0x14) { return usb_status(s); }
    if (o == 0x1c || o == 0x20) {
        if (!s->usb_rx_count) { return 0; }
        unsigned i = s->usb_rx_head;
        uint32_t result = s->usb_rx[i].ep | (s->usb_rx[i].size << 4) | (s->usb_rx[i].kind << 17);
        if (o == 0x20) {
            unsigned length = (s->usb_rx[i].size + 3) & ~3;
            for (unsigned j = 0; j < length; j++) { queue_push(s, &s->usb_fifo, j < s->usb_rx[i].size ? s->usb_rx[i].bytes[j] : 0); }
            s->usb_rx_head = (i + 1) % ARRAY_SIZE(s->usb_rx); s->usb_rx_count--;
        }
        return result;
    }
    if (o == 0x818) {
        uint32_t result = 0;
        for (unsigned ep = 0; ep < 6; ep++) {
            if (usb_in_status(s, ep)) { result |= 1 << ep; }
            if (s->usb_out[ep]) { result |= 1 << (16 + ep); }
        }
        return result;
    }
    if (o == 0x808) { return 6 | ((s->usb_frame & 2047) << 8); }
    unsigned ep;
    if (o >= 0x900 && o < 0x9c0 && o % 32 == 8) { ep = (o - 0x900) / 32; return usb_in_status(s, ep); }
    if (o >= 0xb00 && o < 0xbc0 && o % 32 == 8) { ep = (o - 0xb00) / 32; return s->usb_out[ep]; }
    if (o >= 0x900 && o < 0x9c0 && o % 32 == 24) { return 1024; }
    if (o >= 0x1000) {
        if (o != 0x1000 || s->usb_fifo.count < 4) {
            sq_fault(s, 0, "usb-rx-fifo-underflow", o, size, 0, "usb"); return 0;
        }
        uint32_t result = 0;
        for (unsigned i = 0; i < 4; i++) { result |= queue_pop(s, &s->usb_fifo) << (i * 8); }
        return result;
    }
    return usb_reg(s, o);
}
static void usb_write(void *opaque, hwaddr o, uint64_t value, unsigned size)
{
    SQ64State *s = opaque;
    if (size != 4 || o % 4 || o >= 0x6000) {
        sq_fault(s, 0, "usb-word-access-required", 0x50000000 + o, size, value, "cpu"); return;
    }
    if (o == 0x14) { s->usb_global &= ~value; usb_signal(s); return; }
    if (o >= 0x900 && o < 0x9c0 && o % 32 == 8) { s->usb_in[(o - 0x900) / 32] &= ~value; return; }
    if (o >= 0xb00 && o < 0xbc0 && o % 32 == 8) { s->usb_out[(o - 0xb00) / 32] &= ~value; return; }
    if (o == 0x804 && (usb_reg(s, o) & 2) && !(value & 2)) {
        s->usb_phase = 0; s->usb_setup_active = false; s->usb_config_count = 0;
        s->usb_last_sof = sq_cycles(s); s->usb_frame = 0;
    }
    s->usb_regs[o / 4] = value;
    if (o >= 0x900 && o < 0x9c0 && o % 32 == 16) {
        unsigned ep = (o - 0x900) / 32, expected = value & 0x7ffff;
        if (expected > sizeof(s->usb_tx[ep])) { sq_fault(s, 0, "usb-in-size", ep, 4, expected, "usb"); return; }
        s->usb_expected[ep] = expected; s->usb_expect[ep] = true; s->usb_tx_count[ep] = 0;
    }
    if (o >= 0x900 && o < 0x9c0 && o % 32 == 0 && (value & 0x80000000)) {
        unsigned ep = (o - 0x900) / 32;
        if (s->usb_expect[ep] && !s->usb_expected[ep]) { usb_finish_in(s, ep); }
    }
    if (o >= 0x1000) {
        unsigned ep = (o - 0x1000) / 0x1000;
        if (o % 0x1000 || ep >= 6 || s->usb_tx_count[ep] + 4 > sizeof(s->usb_tx[ep])) {
            sq_fault(s, 0, "usb-tx-fifo-overflow", o, 4, value, "usb"); return;
        }
        stl_le_p(s->usb_tx[ep] + s->usb_tx_count[ep], value); s->usb_tx_count[ep] += 4;
        if (s->usb_expect[ep] && s->usb_tx_count[ep] >= s->usb_expected[ep]) { usb_finish_in(s, ep); }
    }
}
static void usb_service(SQ64State *s)
{
    if (usb_reg(s, 0x804) & 2) { return; }
    uint64_t cycles = sq_cycles(s);
    if (s->usb_phase > 1 && cycles - s->usb_last_sof >= 216000) {
        unsigned elapsed = (cycles - s->usb_last_sof) / 216000;
        s->usb_frame = (s->usb_frame + elapsed) & 2047; s->usb_last_sof += elapsed * 216000ULL; s->usb_global |= 8;
        if (s->usb_phase == 6 && (usb_reg(s, 0x920) & 0x8000)) { s->usb_in[1] |= 16; }
    }
    if (!s->usb_phase && (usb_reg(s, 0x18) & (1 << 12))) { s->usb_global |= 1 << 12; s->usb_phase = 1; }
    else if (s->usb_phase == 1 && !(s->usb_global & (1 << 12))) {
        s->usb_global |= 1 << 13; s->usb_phase = 2; s->usb_recovery = cycles + 2160000;
    } else if (s->usb_phase == 2 && cycles >= s->usb_recovery) {
        const uint8_t setup[] = {0,5,1,0,0,0,0,0}; usb_setup(s, setup); s->usb_phase = 3;
    } else if (s->usb_phase == 3 && !s->usb_setup_active) {
        const uint8_t setup[] = {128,6,0,2,0,0,255,0}; usb_setup(s, setup); s->usb_phase = 4;
    } else if (s->usb_phase == 4 && !s->usb_setup_active) {
        for (unsigned i = 0; i + 2 <= s->usb_config_count;) {
            unsigned n = s->usb_config[i];
            if (n < 2 || i + n > s->usb_config_count) { break; }
            if (s->usb_config[i + 1] == 5 && n >= 7 && (s->usb_config[i + 3] & 3) == 2 && !(s->usb_config[i + 2] & 128)) {
                s->usb_bulk_out = s->usb_config[i + 2] & 15;
            }
            i += n;
        }
        if (s->usb_bulk_out >= 6) { sq_fault(s, 0, "usb-endpoint-unsupported", s->usb_bulk_out, 0, 0, "usb"); return; }
        const uint8_t setup[] = {0,9,1,0,0,0,0,0}; usb_setup(s, setup); s->usb_phase = 5;
    } else if (s->usb_phase == 5 && !s->usb_setup_active) { s->usb_phase = 6; }
    uint32_t control = usb_reg(s, 0xb00 + s->usb_bulk_out * 32);
    if (s->usb_phase == 6 && s->usb_pending_count && !s->usb_rx_count && !s->usb_fifo.count &&
        (control & 0x8000) && !(control & 0x220000)) {
        unsigned i = s->usb_pending_head;
        usb_receive(s, s->usb_bulk_out, 2, s->usb_pending[i].bytes, s->usb_pending[i].size);
        usb_receive(s, s->usb_bulk_out, 3, NULL, 0); s->usb_out[s->usb_bulk_out] |= 1;
        s->usb_pending_head = (i + 1) % ARRAY_SIZE(s->usb_pending); s->usb_pending_count--;
    }
    usb_signal(s);
}
static const MemoryRegionOps usb_ops = {
    .read = usb_read, .write = usb_write, .endianness = DEVICE_LITTLE_ENDIAN,
    .valid = {.min_access_size = 1, .max_access_size = 4},
};
