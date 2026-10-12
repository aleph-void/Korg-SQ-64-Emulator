ENTRY(reset)
MEMORY { FLASH (rx) : ORIGIN = 0x00200000, LENGTH = 64K
         RAM (rwx) : ORIGIN = 0x20000000, LENGTH = 256K }
SECTIONS {
 .vectors : { KEEP(*(.vectors)) } > FLASH
 .text : { *(.text*) *(.rodata*) } > FLASH
 .bss (NOLOAD) : { *(.bss*) *(COMMON) } > RAM
 /DISCARD/ : { *(.ARM.exidx*) *(.ARM.extab*) *(.comment*) }
}
