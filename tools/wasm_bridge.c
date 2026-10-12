/* Original host acceleration for Unicorn. No device firmware or ROM data.
 * Keep ordinary RAM accesses and instruction accounting inside WebAssembly.
 * JavaScript still owns every peripheral, interrupt and externally visible event.
 */
#include <stdint.h>
#include <stdlib.h>
#include <unicorn/unicorn.h>
#include <unicorn/arm.h>

typedef void (*host_event)(uint32_t kind, uint32_t address, uint32_t size, uint32_t value);
typedef struct {
    /* Shared ABI: ten 32-bit words, accessed through current HEAPU32 views. */
    uint32_t elapsed, deadline, active, powered_off;
    int32_t irq_priority;
    uint8_t *itcm, *flash, *flash_alias, *sram;
    uint32_t budget;
    uc_engine *engine;
    host_event event;
    uc_hook code_hook, read_hook, write_hook;
} sq64_bridge;

static const uint8_t *code_pointer(sq64_bridge *s, uint32_t pc) {
    if (pc < 0x4000 - 1) return s->itcm + pc;
    if (pc >= 0x200000 && pc < 0x210000 - 1) return s->flash + pc - 0x200000;
    if (pc >= 0x08000000 && pc < 0x08010000 - 1) return s->flash_alias + pc - 0x08000000;
    if (pc >= 0x20000000 && pc < 0x20040000 - 1) return s->sram + pc - 0x20000000;
    return NULL;
}

static void code(uc_engine *uc, uint64_t address, uint32_t size, void *user) {
    sq64_bridge *s = user;
    if (s->powered_off || !s->budget) { uc_emu_stop(uc); return; }
    s->budget--;
    s->elapsed++;
    const uint8_t *p = code_pointer(s, (uint32_t)address);
    uint16_t op = p ? p[0] | ((uint16_t)p[1] << 8) : 0;
    int observe = !p || s->elapsed >= s->deadline
        || ((op & 0xff00) == 0xbf00 && (op & 15) && ((op >> 4) & 15) < 14)
        || (s->active && (op & 0xec00) == 0xec00);
    if (!observe && s->irq_priority >= 0) {
        uint32_t primask, faultmask, basepri;
        uc_reg_read(uc, UC_ARM_REG_PRIMASK, &primask);
        uc_reg_read(uc, UC_ARM_REG_FAULTMASK, &faultmask);
        uc_reg_read(uc, UC_ARM_REG_BASEPRI, &basepri);
        basepri &= 240;
        observe = !primask && !faultmask && (!basepri || s->irq_priority < (int)basepri);
    }
    if (observe) s->event(0, (uint32_t)address, 0, 0);
}

/* Pure filter: uninterested RAM accesses need no CPU-state reconstruction. */
static bool memory_needed(uc_mem_type type, uint64_t address, int size, void *user) {
    uint32_t a = (uint32_t)address;
    return (size > 1 && (a & ((size < 4 ? size : 4) - 1)))
        || a >= 0x40000000
        || (type == UC_MEM_WRITE && ((a >= 0x200000 && a < 0x210000)
            || (a >= 0x08000000 && a < 0x08010000)));
}

static void memory(uc_engine *uc, uc_mem_type type, uint64_t address,
                   int size, int64_t value, void *user) {
    sq64_bridge *s = user;
    uint32_t a = (uint32_t)address;
    int unaligned = size > 1 && (a & ((size < 4 ? size : 4) - 1));
    int peripheral = a >= 0x40000000;
    int flash_write = type == UC_MEM_WRITE &&
        ((a >= 0x200000 && a < 0x210000) || (a >= 0x08000000 && a < 0x08010000));
    if (unaligned || peripheral || flash_write)
        s->event(type == UC_MEM_WRITE ? 2 : 1, a, (uint32_t)size, (uint32_t)value);
}

sq64_bridge *sq64_bridge_new(uc_engine *engine, host_event event) {
    sq64_bridge *s = calloc(1, sizeof(*s));
    if (!s) return NULL;
    s->engine = engine; s->event = event; s->deadline = 1; s->irq_priority = -1;
    if (uc_hook_add(engine, &s->code_hook, UC_HOOK_CODE, code, s, 1, 0)
        || uc_hook_add(engine, &s->read_hook, UC_HOOK_MEM_READ, memory, s, 1, 0)
        || uc_hook_add(engine, &s->write_hook, UC_HOOK_MEM_WRITE, memory, s, 1, 0)) {
        if (s->code_hook) uc_hook_del(engine, s->code_hook);
        if (s->read_hook) uc_hook_del(engine, s->read_hook);
        if (s->write_hook) uc_hook_del(engine, s->write_hook);
        free(s); return NULL;
    }
    uc_hook_set_mem_filter(engine, s->read_hook, memory_needed);
    uc_hook_set_mem_filter(engine, s->write_hook, memory_needed);
    return s;
}

void sq64_bridge_free(sq64_bridge *s) {
    if (!s) return;
    uc_hook_del(s->engine, s->code_hook);
    uc_hook_del(s->engine, s->read_hook);
    uc_hook_del(s->engine, s->write_hook);
    free(s);
}
