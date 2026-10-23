/* SPDX-License-Identifier: GPL-2.0-only
 * Exact selected-image exception to the default-on native critical monitor.
 * A matching complete ordered host transfer is required. No guard-disable flag.
 */
typedef struct SQInstallation {
    unsigned phase, protocol, packet_size, flags, submitted, count;
    bool mutation_attempted;
    uint8_t payload[0x38000], spi[0x30000], version[2];
    uint8_t midi[16384]; unsigned midi_count;
    char *sha256;
} SQInstallation;
static bool install_prepare(SQInstallation *i, const uint8_t *vsb, unsigned n,
                            unsigned protocol, unsigned size, unsigned flags, Error **errp)
{
    static const uint8_t product[16] = {'S','Q','-','6','4'};
    static const uint32_t regions[][2] = {{0,0x10000},{0x10000,0x4000},{0x14000,0xbdd8},{0x20000,0x14000}};
    if (i->phase == 3) { error_setg(errp, "Restart before submitting another installation"); return false; }
    if (n != 0x38100 || memcmp(vsb, "KORG SYSTEM FILE", 16) || memcmp(vsb + 16, product, 16) ||
        memcmp(vsb + 32, "SYSTEM\0\0", 8) || vsb[0x29] || memcmp(vsb + 0x2c, "\0\1\x60\xff", 4) ||
        ldl_le_p(vsb + 0x30) || ldl_le_p(vsb + 0x34) != 0x38000 ||
        ldl_le_p(vsb + 0x38) || ldl_le_p(vsb + 0x3c) != 0x38000 ||
        vsb[0x2a] >= 64 || vsb[0x2b] >= 128 ||
        (ldl_le_p(vsb + 0x44) > 60000 && ldl_le_p(vsb + 0x44) != UINT32_MAX)) {
        error_setg(errp, "Invalid complete SQ-64 VSB candidate"); return false;
    }
    if (protocol > 1 || !size || size > 1024 || 0x38000 % size || flags > 127 ||
        (!protocol && 0x38000 / size > 16384)) {
        error_setg(errp, "Invalid negotiated update geometry"); return false;
    }
    const uint8_t *p = vsb + 256; uint32_t sp = ldl_le_p(p), reset = ldl_le_p(p + 4);
    if (sp <= 0x20000000 || sp > 0x20040000 || (sp & 7) || !(reset & 1) ||
        (reset & ~1U) < 0x200008 || (reset & ~1U) >= 0x210000) {
        error_setg(errp, "Invalid candidate reset vectors"); return false;
    }
    for (unsigned r = 0; r < ARRAY_SIZE(regions); r++) {
        uint32_t sum = 0;
        for (unsigned a = regions[r][0]; a < regions[r][0] + regions[r][1]; a += 2) { sum += lduw_le_p(p + a); }
        if (sum & 65535) { error_setg(errp, "Candidate checksum region %u failed", r); return false; }
    }
    g_free(i->sha256); memset(i, 0, sizeof(*i));
    i->phase = 1; i->protocol = protocol; i->packet_size = size; i->flags = flags;
    i->count = 0x38000 / size; i->version[0] = vsb[0x2a]; i->version[1] = vsb[0x2b];
    memcpy(i->payload, p, sizeof(i->payload)); memset(i->spi, 255, sizeof(i->spi));
    memcpy(i->spi, p + 0x10000, 0x4000); memcpy(i->spi + 0x4000, p + 0x34000, 0x4000);
    memcpy(i->spi + 0x10000, p + 0x14000, 0x20000);
    i->sha256 = g_compute_checksum_for_data(G_CHECKSUM_SHA256, vsb, n); return true;
}
static unsigned install_integer(uint8_t *out, unsigned value, unsigned width)
{
    for (unsigned j = 0; j < width; j++) { out[j] = (value >> (7 * (width - j - 1))) & 127; }
    return width;
}
static unsigned install_expected(SQInstallation *i, uint8_t out[1200])
{
    static const uint8_t prefix[] = {0xf0,0x42,0x23,0,1,0x60};
    memcpy(out, prefix, sizeof(prefix)); unsigned n = sizeof(prefix);
    if (i->phase == 1) {
        out[n++] = 4; out[n++] = 0; out[n++] = 0;
        if (i->protocol) {
            n += install_integer(out + n, 0, 4); n += install_integer(out + n, 0x38000, 4);
        }
        out[n++] = i->version[0] | 0x40; out[n++] = i->version[1];
        if (i->protocol) { n += install_integer(out + n, i->packet_size, 4); }
    } else if (i->phase == 2 && i->submitted < i->count) {
        const uint8_t *raw = i->payload + i->submitted * i->packet_size;
        bool fill = i->flags & 2;
        for (unsigned j = 1; j < i->packet_size; j++) { if (raw[j] != raw[0]) { fill = false; break; } }
        out[n++] = fill ? 8 : 6; n += install_integer(out + n, i->submitted, i->protocol ? 4 : 2);
        if (fill) { out[n++] = raw[0] >> 4; out[n++] = raw[0] & 15; }
        else {
            unsigned checksum = 0;
            for (unsigned j = 0; j < i->packet_size; j += 7) {
                unsigned group = MIN(7, i->packet_size - j), mask = 0;
                for (unsigned k = 0; k < group; k++) { mask |= (raw[j + k] >> 7) << k; }
                out[n++] = mask; checksum += mask;
                for (unsigned k = 0; k < group; k++) { unsigned byte = raw[j + k] & 127; out[n++] = byte; checksum += byte; }
            }
            out[n++] = checksum & 127;
        }
    } else { return 0; }
    out[n++] = 0xf7; return n;
}
static void install_receive(SQInstallation *i, const uint8_t *message, unsigned n)
{
    if (!i->phase) { return; }
    uint8_t expected[1200]; unsigned count = install_expected(i, expected);
    if (!count || n != count || memcmp(message, expected, n)) { i->phase = 4; return; }
    if (i->phase == 1) { i->phase = 2; }
    else if (++i->submitted == i->count) { i->phase = 3; }
}
static void install_feed(SQInstallation *i, uint8_t byte)
{
    if (!i->phase) { return; }
    if (byte == 0xf0) {
        if (i->midi_count) { i->phase = 4; }
        i->midi_count = 1; i->midi[0] = byte;
    } else if (i->midi_count && (byte < 128 || byte == 0xf7)) {
        if (i->midi_count == sizeof(i->midi)) { i->phase = 4; i->midi_count = 0; return; }
        i->midi[i->midi_count++] = byte;
        if (byte == 0xf7) { install_receive(i, i->midi, i->midi_count); i->midi_count = 0; }
    } else { i->phase = 4; i->midi_count = 0; }
}
static bool install_allow(SQInstallation *i, bool allowed)
{
    if (i->phase != 3 || !allowed) { return false; }
    i->mutation_attempted = true; return true;
}
static bool install_internal(SQInstallation *i, uint64_t a, unsigned n, uint64_t value, const char *source)
{
    unsigned offset = a - 0x08000000;
    return install_allow(i, !strcmp(source, "cpu") && n == 4 && a >= 0x08000000 &&
                         a + n <= 0x08010000 && !(offset & 3) && value == ldl_le_p(i->payload + offset));
}
static bool install_erase(SQInstallation *i, uint64_t a, unsigned n, uint64_t value, bool known, const char *source)
{
    return install_allow(i, !strcmp(source, "cpu") && a == 0x40023c10 && n == 4 && known &&
                         !(value & 4) && ((value >> 3) & 15) < 4);
}
static bool install_spi(SQInstallation *i, const char *operation, unsigned a, unsigned n, unsigned value)
{
    bool geometry = (uint64_t)a + n <= sizeof(i->spi);
    bool erase = !strcmp(operation, "erase") && (n == 4096 || n == 65536) && !(a % n);
    bool program = !strcmp(operation, "program") && n == 1 && a < sizeof(i->spi) && value == i->spi[a];
    return install_allow(i, geometry && (erase || program));
}
