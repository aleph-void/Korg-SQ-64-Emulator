/* SPDX-License-Identifier: GPL-2.0-only
 * Presentation boundary only: all state below belongs to the native board.
 */
static char *hex_bytes(const uint8_t *data, unsigned n)
{
    static const char hex[] = "0123456789abcdef";
    char *text = g_malloc(n * 2 + 1);
    for (unsigned i = 0; i < n; i++) { text[2 * i] = hex[data[i] >> 4]; text[2 * i + 1] = hex[data[i] & 15]; }
    text[2 * n] = 0; return text;
}
static uint8_t *parse_hex(const char *text, unsigned limit, unsigned *length, Error **errp)
{
    if (!text || strlen(text) % 2 || strlen(text) / 2 > limit) {
        error_setg(errp, "Invalid or oversized hex byte string"); return NULL;
    }
    unsigned n = strlen(text) / 2; uint8_t *data = g_malloc(MAX(1, n));
    for (unsigned i = 0; i < n; i++) {
        int a = g_ascii_xdigit_value(text[2 * i]), b = g_ascii_xdigit_value(text[2 * i + 1]);
        if (a < 0 || b < 0) { g_free(data); error_setg(errp, "Invalid hex byte string"); return NULL; }
        data[i] = a * 16 + b;
    }
    *length = n; return data;
}
static void sq_status_get(Object *object, Visitor *v, const char *name, void *opaque, Error **errp)
{
    SQ64State *s = SQ64(object); QDict *d = qdict_new();
    qdict_put_str(d, "backend", "qemu-tcg");
    qdict_put_int(d, "virtualTimeNs", qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL));
    qdict_put_int(d, "virtualCycles", sq_cycles(s));
    qdict_put_int(d, "cyclesPerInstruction", 16);
    qdict_put_int(d, "nominalCpuHz", 216000000);
    qdict_put_str(d, "timing", "icount shift=0; 16 experimental HCLK cycles per virtual ns; not physical timing");
    qdict_put_bool(d, "faulted", s->fault); qdict_put_bool(d, "poweredOff", s->powered_off);
    qdict_put_bool(d, "powerButton", s->power_button); qdict_put_bool(d, "syncConnected", s->sync_connected);
    qdict_put_int(d, "flashWrites", s->spi_writes); qdict_put_bool(d, "flashBusy", s->spi_operation != 0);
    qdict_put_int(d, "displayFrames", s->display_frames); qdict_put_int(d, "triggers", s->triggers);
    qdict_put_int(d, "usbPhase", s->usb_phase); qdict_put_int(d, "queuedPackets", s->usb_pending_count);
    qdict_put_int(d, "pc", s->arm.cpu->env.regs[15]); qdict_put_int(d, "runs", s->runs);
    if (s->fault) {
        QDict *f = qdict_new(); qdict_put_int(f, "criticalId", s->critical_id);
        qdict_put_int(f, "address", s->fault_address); qdict_put_int(f, "size", s->fault_size);
        qdict_put_int(f, "value", s->fault_value); qdict_put_int(f, "pc", s->fault_pc);
        qdict_put_str(f, "operation", s->fault_operation); qdict_put_str(f, "source", s->fault_source);
        qdict_put_obj(d, "fault", QOBJECT(f));
    }
    g_autofree char *display = hex_bytes(s->display, sizeof(s->display)); qdict_put_str(d, "displayHex", display);
    g_autofree char *leds = hex_bytes(&s->led_rows[0][0], sizeof(s->led_rows)); qdict_put_str(d, "ledRowsHex", leds);
    QList *midi = qlist_new();
    for (unsigned i = 0; i + 2 < s->midi_output.count; i += 3) {
        QDict *event = qdict_new(); unsigned head = s->midi_output.head + i;
        qdict_put_int(event, "port", s->midi_output.data[head % QUEUE_SIZE]);
        qdict_put_int(event, "cable", s->midi_output.data[(head + 1) % QUEUE_SIZE]);
        qdict_put_int(event, "byte", s->midi_output.data[(head + 2) % QUEUE_SIZE]);
        qlist_append_obj(midi, QOBJECT(event));
    }
    qdict_put_obj(d, "midiOut", QOBJECT(midi));
    GString *json = qobject_to_json(QOBJECT(d)); char *text = json->str;
    visit_type_str(v, name, &text, errp); g_string_free(json, true); qobject_unref(d);
}
static void sq_control_set(Object *object, Visitor *v, const char *name, void *opaque, Error **errp)
{
    SQ64State *s = SQ64(object); g_autofree char *text = NULL;
    if (!visit_type_str(v, name, &text, errp)) { return; }
    if (s->fault || s->powered_off) { error_setg(errp, "Terminated session: create a fresh native process"); return; }
    if (runstate_is_running()) { error_setg(errp, "Pause the native CPU before control changes"); return; }
    QObject *obj = qobject_from_json(text, errp); if (!obj) { return; }
    QDict *d = qobject_to(QDict, obj); const char *op = d ? qdict_get_try_str(d, "operation") : NULL;
    if (!op) { error_setg(errp, "Control requires an operation"); goto done; }
    if (!strcmp(op, "run")) {
        int64_t ticks = qdict_get_try_int(d, "ticks", 0);
        if (ticks < 1 || ticks > 1000000000) { error_setg(errp, "Run ticks must be 1..1000000000"); goto done; }
        s->instructions_requested += ticks;
        timer_mod(s->quantum, qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL) + ticks); vm_start();
    } else if (!strcmp(op, "midi-drain")) {
        s->midi_output.head = s->midi_output.count = 0;
    } else if (!strcmp(op, "usb-packets") || !strcmp(op, "din-bytes")) {
        unsigned n; g_autofree uint8_t *bytes = parse_hex(qdict_get_try_str(d, "hex"), 65536, &n, errp);
        if (!bytes) { goto done; }
        if (!strcmp(op, "usb-packets")) {
            if (n % 4 || s->usb_pending_count + (n + 63) / 64 > ARRAY_SIZE(s->usb_pending)) {
                error_setg(errp, "Invalid or full USB MIDI input queue"); goto done;
            }
            for (unsigned start = 0; start < n; start += 64) {
                unsigned i = (s->usb_pending_head + s->usb_pending_count++) % ARRAY_SIZE(s->usb_pending);
                s->usb_pending[i].size = MIN(64, n - start); memcpy(s->usb_pending[i].bytes, bytes + start, s->usb_pending[i].size);
            }
        } else {
            int port = qdict_get_try_int(d, "port", 1);
            if (port < 0 || port > 1 || s->din_rx[port].count + n > QUEUE_SIZE) {
                error_setg(errp, "Invalid or full DIN input queue"); goto done;
            }
            for (unsigned i = 0; i < n; i++) { queue_push(s, &s->din_rx[port], bytes[i]); }
            if (reg_get(s, 0x4000440c + port * 0x400) & 32) { pend(s, 38 + port); }
        }
    } else if (!strcmp(op, "panel-row")) {
        int64_t row = qdict_get_try_int(d, "row", -1), bits = qdict_get_try_int(d, "bits", -1);
        if (row < 0 || row > 7 || bits < 0 || bits > UINT32_MAX) { error_setg(errp, "Invalid panel row"); goto done; }
        s->panel_bits[row] = bits;
    } else if (!strcmp(op, "panel-bit")) {
        int row = qdict_get_try_int(d, "row", -1), bit = qdict_get_try_int(d, "bit", -1), value = qdict_get_try_int(d, "value", -1);
        if (row < 0 || row > 7 || bit < 0 || bit > 31 || value < 0 || value > 1) { error_setg(errp, "Invalid raw panel bit"); goto done; }
        s->panel_masks[row] |= 1U << bit; s->panel_raw[row] = (s->panel_raw[row] & ~(1U << bit)) | ((uint32_t)value << bit);
    } else if (!strcmp(op, "encoder") || !strcmp(op, "encoder-lines")) {
        int index = qdict_get_try_int(d, "index", -1), value = qdict_get_try_int(d, "value", 1000);
        if (index < 0 || index > 5) { error_setg(errp, "Invalid encoder index"); goto done; }
        if (!strcmp(op, "encoder-lines")) {
            static const unsigned phase[] = {0,1,3,2};
            if (value < 0 || value > 3) { error_setg(errp, "Invalid encoder line value"); goto done; }
            s->encoder_edges[index].count = s->encoder_edges[index].head = 0; s->encoder_phase[index] = phase[value];
        } else {
            if (value < -128 || value > 128 || s->encoder_edges[index].count + abs(value) * 2 > 4096) {
                error_setg(errp, "Invalid or full encoder queue"); goto done;
            }
            for (unsigned i = 0; i < abs(value) * 2; i++) { queue_push(s, &s->encoder_edges[index], value < 0 ? 255 : 1); }
        }
    } else if (!strcmp(op, "inputs")) {
        if (qdict_haskey(d, "powerButton")) { s->power_button = qdict_get_try_bool(d, "powerButton", false); }
        if (qdict_haskey(d, "syncConnected")) { s->sync_connected = qdict_get_try_bool(d, "syncConnected", false); }
        if (qdict_haskey(d, "adc")) {
            int64_t adc = qdict_get_try_int(d, "adc", -1);
            if (adc < 0 || adc > 65535) { error_setg(errp, "Invalid ADC sample"); goto done; } s->adc_sample = adc;
        }
    } else { error_setg(errp, "Unknown native control operation '%s'", op); }
done:
    qobject_unref(obj);
}
