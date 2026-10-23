/* SPDX-License-Identifier: GPL-2.0-only */
static uint64_t unmapped_read(void *opaque, hwaddr a, unsigned n)
{
    SQ64State *s = opaque; sq_fault(s, 0, "unmapped-read", a, n, 0, "cpu"); return 0;
}
static void unmapped_write(void *opaque, hwaddr a, uint64_t value, unsigned n)
{
    SQ64State *s = opaque;
    if (!critical_memory(s, a, n, value, true, "cpu")) { sq_fault(s, 0, "unmapped-write", a, n, value, "cpu"); }
}
static const MemoryRegionOps unmapped_ops = {
    .read = unmapped_read, .write = unmapped_write, .endianness = DEVICE_LITTLE_ENDIAN,
    .valid = {.min_access_size = 1, .max_access_size = 4, .unaligned = true},
    .impl = {.min_access_size = 1, .max_access_size = 4, .unaligned = true},
};
static void internal_write(void *opaque, hwaddr offset, uint64_t value, unsigned n)
{
    critical_memory(opaque, FLASH_BASE + offset, n, value, true, "cpu");
}
static const MemoryRegionOps internal_ops = {
    .write = internal_write, .endianness = DEVICE_LITTLE_ENDIAN,
    .valid = {.min_access_size = 1, .max_access_size = 4, .unaligned = true},
};
static uint64_t alias_read(void *opaque, hwaddr offset, unsigned n)
{
    SQ64State *s = opaque; uint8_t *data = memory_region_get_ram_ptr(&s->internal); uint64_t value = 0;
    for (unsigned i = 0; i < n; i++) { value |= (uint64_t)data[offset + i] << (i * 8); } return value;
}
static void alias_write(void *opaque, hwaddr offset, uint64_t value, unsigned n)
{
    critical_memory(opaque, 0x08000000 + offset, n, value, true, "cpu");
}
static const MemoryRegionOps alias_ops = {
    .read = alias_read, .write = alias_write, .endianness = DEVICE_LITTLE_ENDIAN,
    .valid = {.min_access_size = 1, .max_access_size = 4, .unaligned = true},
};
static void sq_vm_state(void *opaque, bool running, RunState state)
{
    SQ64State *s = opaque;
    if (running && (s->fault || s->powered_off)) { vm_stop(RUN_STATE_INTERNAL_ERROR); }
}
static void sq_machine_init(MachineState *machine)
{
    SQ64State *s = SQ64(machine); MemoryRegion *memory = get_system_memory();
    memory_region_init_io(&s->system_guard, OBJECT(s), &unmapped_ops, s, "sq64-unmapped", 0x100000000ULL);
    memory_region_add_subregion_overlap(memory, 0, &s->system_guard, -100);
    memory_region_init_ram(&s->sram, OBJECT(s), "sq64-sram", SRAM_SIZE, &error_fatal);
    memory_region_add_subregion(memory, SRAM_BASE, &s->sram);
    memory_region_init_ram(&s->lowram, OBJECT(s), "sq64-low-ram", 0x4000, &error_fatal);
    memory_region_add_subregion(memory, 0, &s->lowram);
    memory_region_init_rom_device_nomigrate(&s->internal, OBJECT(s), &internal_ops, s, "sq64-internal", FLASH_SIZE, &error_fatal);
    memset(memory_region_get_ram_ptr(&s->internal), 255, FLASH_SIZE);
    memory_region_add_subregion(memory, FLASH_BASE, &s->internal);
    memory_region_init_io(&s->alias, OBJECT(s), &alias_ops, s, "sq64-program-alias", FLASH_SIZE);
    memory_region_add_subregion(memory, 0x08000000, &s->alias);
    memory_region_init_io(&s->mmio, OBJECT(s), &peripheral_ops, s, "sq64-peripherals", REG_SIZE);
    memory_region_add_subregion(memory, 0x40000000, &s->mmio);
    memory_region_init_io(&s->usb_mmio, OBJECT(s), &usb_ops, s, "sq64-usb", 0x6000);
    memory_region_add_subregion(memory, 0x50000000, &s->usb_mmio);
    s->clock = clock_new(OBJECT(s), "experimental-hclk");
    clock_set(s->clock, CLOCK_PERIOD_FROM_HZ(16000000000ULL));
    object_initialize_child(OBJECT(s), "armv7m", &s->arm, TYPE_ARMV7M);
    DeviceState *arm = DEVICE(&s->arm);
    qdev_prop_set_string(arm, "cpu-type", ARM_CPU_TYPE_NAME("cortex-m7"));
    qdev_prop_set_uint32(arm, "num-irq", 96); qdev_prop_set_uint32(arm, "init-svtor", FLASH_BASE);
    qdev_prop_set_uint32(arm, "mpu-ns-regions", 16);
    qdev_connect_clock_in(arm, "cpuclk", s->clock); qdev_connect_clock_in(arm, "refclk", s->clock);
    object_property_set_link(OBJECT(arm), "memory", OBJECT(memory), &error_abort);
    sysbus_realize(SYS_BUS_DEVICE(arm), &error_fatal);
    memset(s->spi, 255, SPI_SIZE); memset(s->panel_rx, 255, sizeof(s->panel_rx));
    s->spi_fd = -1;
    if (s->spi_path) {
        struct stat st; s->spi_fd = open(s->spi_path, O_RDWR | O_NOFOLLOW);
        if (s->spi_fd < 0 || fstat(s->spi_fd, &st) || !S_ISREG(st.st_mode) || st.st_size != SPI_SIZE ||
            pread(s->spi_fd, s->spi, SPI_SIZE, 0) != SPI_SIZE) {
            error_report("SQ-64 SPI state must be an existing regular 16 MiB file"); exit(1);
        }
    }
    s->flash_control = 0x80000000; s->adc_sample = 0xc000;
    s->spi_program_cycles = 1024; s->spi_erase_cycles = 65536; s->spi_block_cycles = 262144;
    s->usb_regs[0x804 / 4] = 2; s->usb_bulk_out = 1;
    const unsigned bases[] = {0x40000000,0x40000400,0x40000800,0x40000c00,0x40001000,0x40001400,0x40011400};
    const unsigned irqs[] = {28,29,30,50,54,55,24};
    for (unsigned i = 0; i < ARRAY_SIZE(s->timers); i++) {
        s->timers[i].board = s; s->timers[i].base = bases[i]; s->timers[i].irq = irqs[i];
        s->timers[i].timer = timer_new_ns(QEMU_CLOCK_VIRTUAL, sq_timer_expired, &s->timers[i]);
    }
    s->service = timer_new_ns(QEMU_CLOCK_VIRTUAL, service_tick, s);
    s->quantum = timer_new_ns(QEMU_CLOCK_VIRTUAL, quantum_end, s); timer_mod(s->service, 128);
    qemu_add_vm_change_state_handler(sq_vm_state, s);
    armv7m_load_kernel(s->arm.cpu, machine->kernel_filename, FLASH_BASE, FLASH_SIZE);
    object_property_add(OBJECT(s), "av-state", "str", sq_status_get, NULL, NULL, s);
    object_property_add(OBJECT(s), "av-control", "str", NULL, sq_control_set, NULL, s);
}
static char *sq_spi_get(Object *object, Error **errp) { return g_strdup(SQ64(object)->spi_path); }
static void sq_spi_set(Object *object, const char *value, Error **errp)
{
    SQ64State *s = SQ64(object); g_free(s->spi_path); s->spi_path = g_strdup(value);
}
static void sq_class_init(ObjectClass *klass, const void *data)
{
    MachineClass *mc = MACHINE_CLASS(klass); mc->desc = "SQ-64 experimental native Cortex-M7 board";
    mc->init = sq_machine_init; mc->default_cpu_type = ARM_CPU_TYPE_NAME("cortex-m7");
    mc->default_ram_size = SRAM_SIZE; mc->max_cpus = 1;
    object_class_property_add_str(klass, "spi-state", sq_spi_get, sq_spi_set);
}
static const TypeInfo sq_type = {
    .name = TYPE_SQ64, .parent = TYPE_MACHINE, .instance_size = sizeof(SQ64State), .class_init = sq_class_init,
};
static void sq_register_types(void) { type_register_static(&sq_type); }
type_init(sq_register_types)
