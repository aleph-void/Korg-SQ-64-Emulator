/* SPDX-License-Identifier: GPL-2.0-only
 * Native SQ-64 experimental board. CPU, NVIC and exception semantics are QEMU.
 * Peripheral facts come from this project's pinned interface contract. No
 * firmware routine substitution or host instruction interpreter is present.
 */
#include "qemu/osdep.h"
#include "qapi/error.h"
#include "qobject/qdict.h"
#include "qobject/qjson.h"
#include "qobject/qnum.h"
#include "qobject/qstring.h"
#include "qobject/qlist.h"
#include "qapi/visitor.h"
#include "qemu/bswap.h"
#include "qemu/error-report.h"
#include "qemu/main-loop.h"
#include "qemu/timer.h"
#include "qemu/cutils.h"
#include "qemu/host-utils.h"
#include "hw/irq.h"
#include "hw/boards.h"
#include "hw/loader.h"
#include "hw/arm/armv7m.h"
#include "hw/arm/boot.h"
#include "hw/arm/machines-qom.h"
#include "hw/qdev-properties.h"
#include "hw/qdev-clock.h"
#include "system/address-spaces.h"
#include "system/runstate.h"
#include "system/cpus.h"
#include "system/system.h"
#include "target/arm/internals.h"

#define TYPE_SQ64 MACHINE_TYPE_NAME("sq64")
#define FLASH_BASE 0x00200000
#define FLASH_SIZE 0x10000
#define SRAM_BASE 0x20000000
#define SRAM_SIZE 0x40000
#define SPI_SIZE 0x1000000
#define REG_SIZE 0x80000
#define QUEUE_SIZE 8192
OBJECT_DECLARE_SIMPLE_TYPE(SQ64State, SQ64)

typedef struct SQQueue {
    uint8_t data[QUEUE_SIZE];
    unsigned head, count;
} SQQueue;

typedef struct SQTimer {
    SQ64State *board;
    QEMUTimer *timer;
    uint32_t base, irq;
    int64_t epoch;
    uint32_t initial;
    uint64_t fraction;
} SQTimer;

struct SQ64State {
    MachineState parent;
    ARMv7MState arm;
    Clock *clock;
    MemoryRegion internal, alias, sram, lowram, mmio, usb_mmio;
    MemoryRegion internal_guard, alias_guard, system_guard;
    uint8_t registers[REG_SIZE];
    uint8_t spi[SPI_SIZE], panel_rx[48], display[8192];
    SQQueue spi_rx, panel_tx, panel_in, din_rx[2];
    uint64_t display_frames, spi_writes, tick_epoch;
    unsigned scan_position, scan_row;
    bool selected, write_enable, fault;
    int spi_command;
    unsigned spi_position, spi_address, spi_page;
    uint8_t spi_latch[256], spi_pending[256];
    bool spi_valid[256], spi_pending_valid[256];
    unsigned spi_operation, spi_pending_start, spi_pending_size;
    uint64_t spi_deadline, spi_program_cycles, spi_erase_cycles, spi_block_cycles;
    int spi_fd;
    uint32_t panel_bits[8], panel_masks[8], panel_raw[8];
    uint8_t encoder_phase[6], panel_shift[6], panel_shift_rx[6];
    SQQueue encoder_edges[6];
    unsigned panel_shift_count, panel_selected, triggers;
    uint64_t panel_last_cycle;
    uint8_t led_rows[8][32];
    unsigned led_counts[32], led_samples, led_row;
    bool panel_mapping, power_button, sync_connected, powered_off;
    uint32_t usb_regs[0x6000 / 4], usb_global, usb_in[6], usb_out[6];
    uint8_t usb_tx[6][4096], usb_setup[8], usb_config[4096];
    unsigned usb_expected[6], usb_tx_count[6], usb_config_count;
    bool usb_expect[6], usb_setup_active;
    struct { uint8_t ep, kind, size, bytes[64]; } usb_rx[128], usb_pending[1024];
    unsigned usb_rx_head, usb_rx_count, usb_pending_head, usb_pending_count;
    SQQueue usb_fifo, midi_output;
    unsigned usb_phase, usb_bulk_out, usb_frame;
    uint64_t usb_recovery, usb_last_sof;
    unsigned critical_id, fault_size, fault_pc;
    hwaddr fault_address;
    char fault_operation[96], fault_source[32];
    char *spi_path;
    uint64_t fault_value;
    uint32_t flash_key, flash_control, dma_reload[16];
    uint16_t adc_sample;
    SQTimer timers[7];
    QEMUTimer *service, *quantum;
    uint64_t runs, instructions_requested;
    /* USB transaction state is implemented in sq64-usb.inc. */
};

/* One icount nanosecond represents one CPU instruction. Peripheral HCLK
 * advances by this explicit experimental ratio, never claimed as cycle exact. */
static uint64_t sq_cycles(SQ64State *s)
{
    return qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL) * 16ULL;
}

static void sq_fault(SQ64State *s, unsigned critical, const char *operation,
                     hwaddr address, unsigned size, uint64_t value, const char *source)
{
    if (!s->fault) {
        s->critical_id = critical;
        s->fault_address = address;
        s->fault_size = size;
        s->fault_value = value;
        s->fault_pc = s->arm.cpu ? s->arm.cpu->env.regs[15] : 0;
        pstrcpy(s->fault_operation, sizeof(s->fault_operation), operation);
        pstrcpy(s->fault_source, sizeof(s->fault_source), source);
    }
    s->fault = true;
    vm_stop(RUN_STATE_INTERNAL_ERROR);
    CPUState *cpu = s->arm.cpu ? CPU(s->arm.cpu) : NULL;
    if (cpu && current_cpu == cpu) {
        cpu->exception_index = EXCP_INTERRUPT;
        cpu_loop_exit_restore(cpu, cpu->mem_io_pc);
    }
}

static bool overlap(uint64_t a, uint64_t n, uint64_t base, uint64_t size)
{
    return a < base + size && base < a + n;
}

static bool critical_memory(SQ64State *s, hwaddr a, uint64_t n, uint64_t value,
                            bool known, const char *source)
{
    if (s->fault) { return true; }
    if (overlap(a, n, 0x200000, 0x100000) || overlap(a, n, 0x8000000, 0x200000)) {
        sq_fault(s, 1, "internal-flash-write", a, n, value, source);
        return true;
    }
    if (overlap(a, n, 0x1ff00000, 0x100000) || overlap(a, n, 0x40023c08, 4) ||
        overlap(a, n, 0x40023c14, 12)) {
        sq_fault(s, 2, "system-or-option-write", a, n, value, source);
        return true;
    }
    if (overlap(a, n, 0x40023c10, 4)) {
        uint64_t bits = a <= 0x40023c10 ? value >> ((0x40023c10 - a) * 8) :
                        value << ((a - 0x40023c10) * 8);
        if (!known || (bits & 6)) {
            sq_fault(s, 1, "internal-flash-erase-armed", a, n, value, source);
            return true;
        }
    }
    return false;
}

static uint32_t reg_get(SQ64State *s, uint32_t address)
{
    assert(address >= 0x40000000 && address <= 0x40000000 + REG_SIZE - 4);
    return ldl_le_p(s->registers + address - 0x40000000);
}
static void reg_put(SQ64State *s, uint32_t address, uint32_t value)
{
    assert(address >= 0x40000000 && address <= 0x40000000 + REG_SIZE - 4);
    stl_le_p(s->registers + address - 0x40000000, value);
}
static void queue_push(SQ64State *s, SQQueue *q, uint8_t byte)
{
    if (q->count == QUEUE_SIZE) {
        sq_fault(s, 0, "peripheral-fifo-overflow", 0, 1, byte, "device");
        return;
    }
    q->data[(q->head + q->count++) % QUEUE_SIZE] = byte;
}
static uint8_t queue_pop(SQ64State *s, SQQueue *q)
{
    if (!q->count) {
        sq_fault(s, 0, "peripheral-fifo-underflow", 0, 1, 0, "device");
        return 0;
    }
    uint8_t value = q->data[q->head];
    q->head = (q->head + 1) % QUEUE_SIZE;
    q->count--;
    return value;
}
static void pend(SQ64State *s, unsigned irq)
{
    qemu_irq line = qdev_get_gpio_in(DEVICE(&s->arm), irq);
    qemu_irq_pulse(line);
}

#include "sq64-spi.inc"
#include "sq64-panel.inc"
#include "sq64-dma.inc"
#include "sq64-usb.inc"

#include "sq64-peripherals.inc"
#include "sq64-control.inc"
#include "sq64-machine.inc"
