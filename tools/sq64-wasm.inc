/* SPDX-License-Identifier: GPL-2.0-only
 * Browser transport: QEMU's iothread owns dispatch and the BQL. The JavaScript
 * worker only submits and collects an atomic mailbox, so native filesystem or
 * libffi callbacks can run while an asynchronous browser request is pending.
 */
#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#include "qemu/atomic.h"
static char *web_request, *web_response;
static int web_busy, web_ready;
static bool web_waiting, web_stepping;
static QEMUTimer *web_timer;

EMSCRIPTEN_KEEPALIVE int sq64_web_ready(void) { return qatomic_read(&web_ready); }
EMSCRIPTEN_KEEPALIVE int sq64_web_submit(const char *text)
{
    if (!qatomic_read(&web_ready) || qatomic_cmpxchg(&web_busy, 0, 1)) { return 0; }
    qatomic_set(&web_request, g_strdup(text)); return 1;
}
EMSCRIPTEN_KEEPALIVE char *sq64_web_take(void)
{
    char *result = qatomic_xchg(&web_response, NULL);
    if (result) { qatomic_set(&web_busy, 0); }
    return result;
}
static char *web_json(QObject *object)
{
    GString *s = qobject_to_json(object); qobject_unref(object); return g_string_free(s, false);
}
static char *web_error(const char *error)
{
    QDict *d = qdict_new(); qdict_put_str(d, "error", error); return web_json(QOBJECT(d));
}
static char *web_state(SQ64State *s)
{
    Error *err = NULL; char *result = object_property_get_str(OBJECT(s), "av-state", &err);
    if (err) { result = web_error(error_get_pretty(err)); error_free(err); }
    return result;
}
static bool web_memory(SQ64State *s, uint64_t a, unsigned n, bool write, uint8_t **ptr)
{
    if (a < 0x4000 && a + n <= 0x4000) { *ptr = memory_region_get_ram_ptr(&s->lowram) + a; return true; }
    if (a >= SRAM_BASE && a + n <= SRAM_BASE + SRAM_SIZE) { *ptr = memory_region_get_ram_ptr(&s->sram) + a - SRAM_BASE; return true; }
    if (write) { return false; }
    if (a >= FLASH_BASE && a + n <= FLASH_BASE + FLASH_SIZE) { *ptr = memory_region_get_ram_ptr(&s->internal) + a - FLASH_BASE; return true; }
    if (a >= 0x08000000 && a + n <= 0x08000000 + FLASH_SIZE) { *ptr = memory_region_get_ram_ptr(&s->internal) + a - 0x08000000; return true; }
    if (a >= 0x40000000 && a + n <= 0x40000000 + REG_SIZE) { *ptr = s->registers + a - 0x40000000; return true; }
    return false;
}
static char *web_dispatch(SQ64State *s, const char *text)
{
    Error *err = NULL; QObject *obj = qobject_from_json(text, &err); char *response = NULL;
    QDict *d = obj ? qobject_to(QDict, obj) : NULL;
    const char *op = d ? qdict_get_try_str(d, "operation") : NULL;
    if (!op) {
        response = web_error(err ? error_get_pretty(err) : "Expected an operation"); goto done;
    }
    if (runstate_is_running()) { response = web_error("Pause native execution before another command"); goto done; }
    if (!strcmp(op, "state")) { response = web_state(s); }
    else if (!strcmp(op, "read") || !strcmp(op, "spi-read") || !strcmp(op, "write-ram")) {
        int64_t a = qdict_get_try_int(d, "address", -1), n = qdict_get_try_int(d, "length", -1);
        bool write = !strcmp(op, "write-ram"); uint8_t *ptr = NULL;
        if (a < 0 || a > UINT32_MAX || n < 0 || n > SPI_SIZE || (uint64_t)a + n > UINT32_MAX + 1ULL) {
            response = web_error("Invalid memory range"); goto done;
        }
        if (!strcmp(op, "spi-read")) { if (a + n <= SPI_SIZE) { ptr = s->spi + a; } }
        else { web_memory(s, a, n, write, &ptr); }
        if (!ptr) { response = web_error("Inspection is restricted to modeled ROM/RAM and device snapshots"); goto done; }
        QDict *result = qdict_new();
        if (write) {
            if (s->fault || s->powered_off) { qobject_unref(result); response = web_error("Terminated native session"); goto done; }
            unsigned length; g_autofree uint8_t *data = parse_hex(qdict_get_try_str(d, "hex"), SRAM_SIZE, &length, &err);
            if (!data || length != n) { qobject_unref(result); response = web_error(err ? error_get_pretty(err) : "Length mismatch"); goto done; }
            address_space_write(&address_space_memory, a, MEMTXATTRS_UNSPECIFIED, data, n); qdict_put_bool(result, "ok", true);
        } else { g_autofree char *hex = hex_bytes(ptr, n); qdict_put_str(result, "hex", hex); }
        response = web_json(QOBJECT(result));
    } else if (!strcmp(op, "registers")) {
        CPUARMState *e = &s->arm.cpu->env; QDict *result = qdict_new();
        for (unsigned i = 0; i < 16; i++) {
            char name[8]; snprintf(name, sizeof(name), "R%u", i); qdict_put_int(result, name, e->regs[i]);
        }
        qdict_put_int(result, "SP", e->regs[13]); qdict_put_int(result, "LR", e->regs[14]); qdict_put_int(result, "PC", e->regs[15]);
        qdict_put_int(result, "XPSR", xpsr_read(e)); qdict_put_int(result, "MSP", *arm_v7m_get_sp_ptr(e, false, false, true));
        qdict_put_int(result, "PSP", *arm_v7m_get_sp_ptr(e, false, true, true));
        qdict_put_int(result, "CONTROL", e->v7m.control[0]); qdict_put_int(result, "PRIMASK", e->v7m.primask[0]);
        qdict_put_int(result, "BASEPRI", e->v7m.basepri[0]); qdict_put_int(result, "FAULTMASK", e->v7m.faultmask[0]);
        response = web_json(QOBJECT(result));
    } else if (!strcmp(op, "step")) {
        if (s->fault || s->powered_off) { response = web_error("Terminated native session"); goto done; }
        timer_del(s->quantum); cpu_single_step(CPU(s->arm.cpu), SSTEP_ENABLE);
        web_stepping = web_waiting = true; vm_start();
    } else {
        object_property_set_str(OBJECT(s), "av-control", text, &err);
        if (err) { response = web_error(error_get_pretty(err)); }
        else if (!strcmp(op, "run")) { web_waiting = true; }
        else { response = web_state(s); }
    }
done:
    if (err) { error_free(err); } if (obj) { qobject_unref(obj); } return response;
}
static void web_poll(void *opaque)
{
    SQ64State *s = opaque;
    qatomic_set(&web_ready, 1);
    char *request = qatomic_xchg(&web_request, NULL);
    if (request) {
        char *response = web_dispatch(s, request); g_free(request);
        if (response) { qatomic_set(&web_response, response); }
    }
    if (web_waiting && !runstate_is_running()) {
        if (web_stepping) { cpu_single_step(CPU(s->arm.cpu), 0); web_stepping = false; }
        web_waiting = false; qatomic_set(&web_response, web_state(s));
    }
    timer_mod(web_timer, qemu_clock_get_ms(QEMU_CLOCK_REALTIME) + 1);
}
static void web_init(SQ64State *s)
{
    web_timer = timer_new_ms(QEMU_CLOCK_REALTIME, web_poll, s);
    timer_mod(web_timer, qemu_clock_get_ms(QEMU_CLOCK_REALTIME) + 1);
}
#endif
