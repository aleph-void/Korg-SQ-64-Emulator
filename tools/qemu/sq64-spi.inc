/* SPDX-License-Identifier: GPL-2.0-only
 * NOR transactions become durable only after their virtual busy deadline.
 * Positive latencies are experiment parameters, not physical measurements.
 */
static void spi_advance(SQ64State *s)
{
    if (!s->spi_operation || sq_cycles(s) < s->spi_deadline) { return; }
    unsigned start = s->spi_pending_start, size = s->spi_pending_size;
    if (s->spi_operation == 2) {
        for (unsigned i = 0; i < 256; i++) {
            if (s->spi_pending_valid[i]) {
                s->spi[start + i] &= s->spi_pending[i]; s->spi_writes++;
            }
        }
    } else { memset(s->spi + start, 255, size); s->spi_writes++; }
    if (s->spi_fd >= 0 && (pwrite(s->spi_fd, s->spi + start, size, start) != size ||
                          fsync(s->spi_fd) < 0)) {
        sq_fault(s, 0, "spi-durable-write", start, size, errno, "spi-flash"); return;
    }
    s->spi_operation = 0; s->write_enable = false;
}
static void spi_select(SQ64State *s, bool selected)
{
    spi_advance(s);
    if (selected && s->selected) {
        sq_fault(s, 0, "flash-already-selected", 0, 0, 0, "spi-flash"); return;
    }
    if (!selected && s->selected && !s->spi_operation) {
        if ((s->spi_command == 4 || s->spi_command == 6) && s->spi_position == 1) {
            s->write_enable = s->spi_command == 6;
        } else if (s->write_enable && ((s->spi_command == 2 && s->spi_position > 4) ||
                    ((s->spi_command == 32 || s->spi_command == 216) && s->spi_position == 4))) {
            unsigned size = s->spi_command == 2 ? 256 : s->spi_command == 32 ? 4096 : 65536;
            uint64_t delay = s->spi_command == 2 ? s->spi_program_cycles :
                             s->spi_command == 32 ? s->spi_erase_cycles : s->spi_block_cycles;
            s->spi_pending_start = s->spi_command == 2 ? s->spi_page : s->spi_address & ~(size - 1);
            s->spi_pending_size = size;
            memcpy(s->spi_pending, s->spi_latch, 256);
            memcpy(s->spi_pending_valid, s->spi_valid, sizeof(s->spi_valid));
            s->spi_operation = s->spi_command; s->spi_deadline = sq_cycles(s) + delay;
        }
    }
    s->selected = selected;
    if (selected) {
        s->spi_position = s->spi_address = 0; s->spi_command = -1;
        memset(s->spi_valid, 0, sizeof(s->spi_valid));
    }
}
static bool spi_installed_guard(SQ64State *s, const char *operation, unsigned a, unsigned n, unsigned value)
{
    if (overlap(a, n, 0, 0x30000)) {
        s->spi_command = -1; memset(s->spi_valid, 0, sizeof(s->spi_valid));
        sq_fault(s, 4, operation, a, n, value, "spi-flash"); return true;
    }
    return false;
}
static uint8_t spi_exchange(SQ64State *s, uint8_t value)
{
    uint8_t result = 255;
    spi_advance(s);
    if (!s->selected) {
        sq_fault(s, 0, "flash-clocked-while-deselected", 0, 1, value, "spi-flash"); return result;
    }
    if (!s->spi_position) {
        switch (value) {
        case 0: case 2: case 3: case 4: case 5: case 6: case 11: case 32: case 159: case 216: break;
        default:
            sq_fault(s, 3, "forbidden-spi-command", 0, 1, value, "spi-flash"); return result;
        }
        s->spi_command = s->spi_operation && value != 5 ? -1 : value;
    } else if ((s->spi_command == 2 || s->spi_command == 3 || s->spi_command == 11 ||
                s->spi_command == 32 || s->spi_command == 216) && s->spi_position <= 3) {
        s->spi_address = (s->spi_address << 8) | value;
        if (s->spi_position == 3) {
            s->spi_page = s->spi_address & ~255;
            if (s->spi_command == 32 || s->spi_command == 216) {
                unsigned size = s->spi_command == 32 ? 4096 : 65536;
                if (spi_installed_guard(s, "erase", s->spi_address & ~(size - 1), size, 0)) { return result; }
            }
        }
    } else if (s->spi_command == 3 || s->spi_command == 11) {
        if (s->spi_command != 11 || s->spi_position > 4) {
            result = s->spi[s->spi_address]; s->spi_address = (s->spi_address + 1) % SPI_SIZE;
        }
    } else if (s->spi_command == 2) {
        if (spi_installed_guard(s, "program", s->spi_address, 1, value)) { return result; }
        s->spi_latch[s->spi_address & 255] = value; s->spi_valid[s->spi_address & 255] = true;
        s->spi_address = s->spi_page | ((s->spi_address + 1) & 255);
    } else if (s->spi_command == 5) {
        result = (s->write_enable ? 2 : 0) | (s->spi_operation ? 1 : 0);
    } else if (s->spi_command == 159) {
        static const uint8_t jedec[] = {0xef, 0x40, 0x18};
        result = jedec[(s->spi_position - 1) % 3];
    }
    s->spi_position++; return result;
}
