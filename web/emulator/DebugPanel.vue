<script setup>
import { computed, ref, watch } from 'vue';
import { save } from '../src/download.js';
const props = defineProps({ state: { type: Object, required: true }, request: { type: Function, required: true } });
const hex = (value) => `0x${value.toString(16).padStart(8, '0')}`;
const bytes = (values) => values.map((value) => value.toString(16).padStart(2, '0')).join(' ');
const busy = ref(false),
  message = ref(''),
  toggle = ref(false);
const breakpoints = ref(''),
  traceLimit = ref(256),
  address = ref('0x00200000'),
  length = ref(128);
const memory = ref('Read memory while paused.');
const debug = computed(() => props.state.report?.debug);
const enabled = computed(() => !!debug.value?.enabled);
const disabled = computed(() => busy.value || !enabled.value || !!props.state.locked);
const stop = computed(() =>
  props.state.report?.error
    ? `Fault: ${props.state.report.error}`
    : debug.value?.stoppedAt != null
      ? `Breakpoint at ${hex(debug.value.stoppedAt)}`
      : props.state.running
        ? 'Running'
        : 'Paused',
);
const points = computed(() => debug.value?.breakpoints?.map(hex).join(', ') || 'No breakpoints');
const registers = computed(() =>
  Object.entries(debug.value?.registers || {})
    .map(([name, value]) => `${name.padEnd(9)} ${hex(value)}`)
    .join('\n'),
);
const trace = computed(
  () =>
    debug.value?.trace
      ?.map((row) => `${String(row.tick).padStart(8)}  ${hex(row.pc)}  ${bytes(row.bytes)}`)
      .join('\n') || 'No trace entries',
);
watch(
  enabled,
  (value) => {
    if (!busy.value) toggle.value = value;
  },
  { immediate: true },
);
// Only committed configuration changes replace drafts; periodic CPU snapshots do not.
watch(
  () => (enabled.value ? JSON.stringify([debug.value.breakpoints, debug.value.traceLimit]) : ''),
  () => {
    if (!enabled.value) return;
    breakpoints.value = debug.value.breakpoints.map(hex).join(' ');
    traceLimit.value = debug.value.traceLimit;
  },
  { immediate: true },
);
watch(
  () => [props.state.report?.imageSha256, props.state.report?.board.ticks, enabled.value],
  ([image, ticks, active], [previousImage, previousTicks]) => {
    if (!active || image !== previousImage || ticks < previousTicks) memory.value = 'Read memory while paused.';
  },
);
async function act(task) {
  if (busy.value) return;
  busy.value = true;
  message.value = '';
  try {
    await task();
  } catch (error) {
    message.value = error.message;
  } finally {
    busy.value = false;
    toggle.value = enabled.value;
  }
}
const setEnabled = () => act(() => props.request('debug', { enabled: toggle.value }));
const step = () => act(() => props.request('step', { instructions: 1 }));
const apply = () =>
  act(() =>
    props.request('debug', {
      breakpoints: breakpoints.value
        .trim()
        .split(/[\s,]+/)
        .filter(Boolean),
      traceLimit: Number(traceLimit.value),
    }),
  );
const readMemory = () =>
  act(async () => {
    const result = await props.request('debug-memory', { address: address.value.trim(), length: Number(length.value) });
    memory.value = Array.from(
      { length: Math.ceil(result.bytes.length / 16) },
      (_, i) => `${hex(result.address + i * 16)}  ${bytes(result.bytes.slice(i * 16, i * 16 + 16))}`,
    ).join('\n');
  });
const saveReport = () => act(async () => save((await props.request('state')).report, 'sq64-debug.json'));
</script>

<template>
  <details class="debugger">
    <summary>Developer debugging</summary>
    <p>
      Enable to pause and inspect your firmware. Debugging slows execution; disabling it restores normal execution
      speed. Reset pauses at the reset vector while enabled.
    </p>
    <label class="debug-toggle"
      ><input
        id="debug-enabled"
        type="checkbox"
        v-model="toggle"
        :disabled="busy || !state.loaded || state.locked"
        @change="setEnabled"
      />
      Enable debugging</label
    >
    <p id="debug-message" role="status">{{ message }}</p>
    <div id="debug-tools" :hidden="!enabled">
      <div class="toolbar">
        <div>
          <button
            id="debug-step"
            :disabled="disabled || !!state.report?.error || !!state.report?.board.poweredOff"
            @click="step"
          >
            Step 1 instruction</button
          ><button id="debug-save" :disabled="disabled" @click="saveReport">Save debug report</button>
        </div>
        <p id="debug-stop" role="status">{{ stop }}</p>
      </div>
      <div class="debug-grid">
        <section>
          <p class="eyebrow">BREAKPOINTS</p>
          <label
            >Addresses (decimal or 0x hexadecimal, separated by spaces)<input
              id="debug-breakpoints"
              placeholder="0x00200008 0x20000000"
              spellcheck="false"
              v-model="breakpoints"
              :disabled="disabled"
          /></label>
          <label
            >Trace entries (0 disables tracing)<input
              id="debug-trace-limit"
              type="number"
              min="0"
              max="4096"
              v-model="traceLimit"
              :disabled="disabled"
          /></label>
          <button id="debug-apply" :disabled="disabled" @click="apply">Apply breakpoints and trace</button>
          <p id="debug-points">{{ points }}</p>
          <p class="hint">
            Apply replaces the breakpoint list and pauses execution. Run continues past the current breakpoint once.
            Loading another image clears browser debug settings.
          </p>
          <p class="eyebrow">REGISTERS</p>
          <pre id="debug-registers" aria-label="CPU registers">{{ registers }}</pre>
        </section>
        <section>
          <p class="eyebrow">MEMORY</p>
          <label
            >Start address<input id="debug-address" spellcheck="false" v-model="address" :disabled="disabled"
          /></label>
          <label
            >Bytes (1–4096)<input
              id="debug-length"
              type="number"
              min="1"
              max="4096"
              v-model="length"
              :disabled="disabled" /></label
          ><button id="debug-read" :disabled="disabled || state.running" @click="readMemory">Read memory</button>
          <p class="hint">
            Read code or RAM while paused. Values are a snapshot taken on request. Peripheral state is included in the
            execution report.
          </p>
          <pre id="debug-memory" aria-label="Memory bytes">{{ memory }}</pre>
          <p class="eyebrow">RECENT INSTRUCTION HOOKS</p>
          <p class="hint">
            Virtual tick · PC · opcode bytes, oldest first. Hooks run before execution and may include a faulting or
            preempted instruction.
          </p>
          <pre id="debug-trace" aria-label="Instruction trace">{{ trace }}</pre>
        </section>
      </div>
    </div>
  </details>
</template>
