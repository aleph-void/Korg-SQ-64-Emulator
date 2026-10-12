/* Original host-integration probe. EMULATOR ONLY. NOT SQ-64 FIRMWARE.
 * Implements a small protocol peer in ARM instructions to test browser MIDI.
 * Updates are stored in a staging region of emulated SPI flash, never installed.
 * The data blocks below are synthetic zero-filled fixtures, not factory data.
 */
#include <stdint.h>
#define REG(a) (*(volatile uint32_t *)(a))
#define SPI_DR (*(volatile uint8_t *)0x4000380c)
#define UART 0x40004800u
static uint8_t received[8192], decoded[1024];
static uint32_t used, packet_index;
static uint8_t prefix[6];
void reset(void);
__attribute__((section(".vectors"), used)) const uintptr_t vectors[2] = {0x20040000, (uintptr_t)reset};
static void byte(uint8_t v) { REG(UART + 4) = v; }
static void start(uint8_t command) { for (unsigned i = 0; i < 6; i++) byte(prefix[i]); byte(command); }
static void end(void) { byte(247); }
static void ack(uint8_t status) { start(prefix[2] == 35 ? 5 : 35); if (prefix[2] == 35) byte(status); end(); }
static uint8_t spi(uint8_t v) { SPI_DR = v; return SPI_DR; }
static void select(int on) { REG(0x40020418) = on ? 0x02000000 : 0x200; }
static void stage(const uint8_t *data, unsigned count, unsigned address) {
  for (unsigned at = 0; at < count; at += 256) {
    select(1); spi(6); select(0);
    select(1); spi(2); spi((address + at) >> 16); spi((address + at) >> 8); spi(address + at);
    for (unsigned i = 0; i < 256 && at + i < count; i++) spi(data[at + i]);
    select(0);
  }
}
static void dump(uint8_t command, unsigned count, const char *tag, int indexed, uint8_t index) {
  start(command); if (indexed) byte(index);
  for (unsigned i = 0; i < count; i += 7) {
    byte(0); /* All synthetic data bytes are seven-bit. */
    for (unsigned j = 0; j < 7 && i + j < count; j++) byte(tag && i + j < 4 ? tag[i + j] : 0);
  }
  end();
}
static void command(void) {
  if (used < 8 || received[0] != 240 || received[1] != 66 || received[3] != 0 || received[4] != 1 || received[5] != 96) return;
  for (unsigned i = 0; i < 6; i++) prefix[i] = received[i];
  uint8_t c = received[6], index = used > 8 ? received[7] : 0;
  if (prefix[2] == 35) {
    if (c == 0 && used == 8) { start(1); byte(1); byte(0); byte(0); byte(8); byte(0); byte(0); end(); }
    else if (c == 2 && used == 9) { start(3); byte(2); byte(3); end(); }
    else if (c == 4 && used == 24) { packet_index = 0; ack(0); }
    else if (c == 6 && used == 1184) {
      unsigned packet = 0, sum = 0, dest = 0;
      for (unsigned i = 7; i < 11; i++) packet = packet * 128 + received[i];
      for (unsigned i = 11; i < used - 2; i++) sum += received[i];
      if (packet != packet_index) { ack(5); return; }
      if ((sum & 127) != received[used - 2]) { ack(6); return; }
      for (unsigned i = 11; i < used - 2;) {
        uint8_t mask = received[i++];
        for (unsigned b = 0; b < 7 && dest < 1024; b++) decoded[dest++] = received[i++] | ((mask >> b & 1) << 7);
      }
      stage(decoded, 1024, 0x40000 + packet * 1024); packet_index++; ack(0);
    } else ack(1);
    return;
  }
  if (prefix[2] < 48 || prefix[2] > 63) return;
  switch (c) {
    case 14: dump(80, 512, "GLOB", 0, 0); break;
    case 20: dump(68, 2048, "CTRL", 0, 0); break;
    case 21: dump(69, 2048, "CTRL", 1, index); break;
    case 23: dump(71, 36, 0, 1, index); break;
    case 17: dump(65, 512, "PROJ", 0, 0); break;
    case 29: start(48); end(); break;
    case 112: ack(0); break;
    case 65: case 68: case 69: case 71: case 72: case 73: case 77: case 80: ack(0); break;
    default: start(38); end(); break;
  }
}
void reset(void) {
  used = packet_index = 0;
  for (;;) {
    if (!(REG(UART) & 32)) continue;
    uint8_t b = REG(UART + 4);
    if (b >= 248) continue;
    if (b == 240) used = 0;
    if (used >= sizeof received) { used = 0; continue; }
    received[used++] = b;
    if (b == 247) { command(); used = 0; }
  }
}
