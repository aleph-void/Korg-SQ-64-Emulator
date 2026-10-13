<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { displayPixels } from './display.js';
import { OUTPUT_GROUPS } from './outputs.js';
import PanelButton from './PanelButton.vue';
import EncoderKnob from './EncoderKnob.vue';
const props = defineProps({ state: { type: Object, required: true }, resetKey: Number });
const emit = defineEmits(['input', 'error']);
const instrument = ref(null),
  display = ref(null),
  fullscreen = ref(false),
  canFullscreen = ref(false);
let context,
  pixels,
  displayDrawn = false;
const displayedBytes = new Uint8Array(8192);
const blankDisplay = new Uint8Array(8192);
const panel = computed(() => props.state.panel);
const poweredOff = computed(() => !!props.state.report?.board.poweredOff);
const disabled = computed(() => !props.state.loaded || props.state.terminated || props.state.locked || poweredOff.value);
const scriptTip = ref(false);
let scriptTipTimer;
function hideScriptTip() {
  clearTimeout(scriptTipTimer);
  scriptTip.value = false;
}
// Panel controls are disabled while a script plays, so pointer and wheel
// gestures never reach them; catch the attempt here and say why.
function blockedInput(event) {
  const over = event.type === 'wheel' ? '.knobs' : '.knobs, .button-row, .matrix';
  if (!props.state.scripting || !event.target.closest(over)) return;
  if (event.cancelable) event.preventDefault();
  scriptTip.value = true;
  clearTimeout(scriptTipTimer);
  scriptTipTimer = setTimeout(hideScriptTip, 5000);
}
watch(() => props.state.scripting, hideScriptTip);
const smooth = computed(
  () =>
    props.state.loaded &&
    props.state.running &&
    !props.state.report?.debug?.enabled &&
    !props.state.report?.error &&
    !poweredOff.value,
);
const displayStatus = computed(() =>
  poweredOff.value
    ? 'POWERED OFF'
    : panel.value?.displayFrames
      ? `${panel.value.displayFrames} FRAME TRANSACTIONS`
      : props.state.running
        ? 'STARTING FIRMWARE…'
        : 'WAITING FOR FIRMWARE',
);
const groups = {
  transport: ['tap', 'record', 'stop', 'play', 'control'],
  modes: ['project', 'global', 'pattern', 'gate', 'pitch', 'mod', 'loop'],
  bars: ['bar1', 'bar2', 'bar3', 'bar4', 'shift'],
};
const matrix = [...'ABCD'].flatMap((track) => [
  { control: `track${track}`, label: track, pad: false },
  ...Array.from({ length: 16 }, (_, i) => ({ control: track + (i + 1), label: String(i + 1), pad: true })),
]);
const outputLevel = (id) => (props.state.loaded && !props.state.terminated && !poweredOff.value ? panel.value?.outputs?.[id] || 0 : 0);
const buttonProps = (control) => ({
  control,
  disabled: disabled.value,
  down: !!panel.value?.buttons[control],
  level: panel.value?.leds[control] || 0,
  resetKey: props.resetKey,
});
function paint() {
  const bytes = poweredOff.value ? blankDisplay : panel.value?.display;
  if (!context || !bytes) return;
  if (!displayDrawn || bytes.some((byte, i) => byte !== displayedBytes[i])) {
    displayPixels(bytes, pixels.data);
    context.putImageData(pixels, 0, 0);
    displayedBytes.set(bytes);
    displayDrawn = true;
  }
}
watch(() => props.state, paint, { flush: 'post' });
function fullscreenChanged() {
  fullscreen.value = !!document.fullscreenElement;
}
async function toggleFullscreen() {
  try {
    await (document.fullscreenElement ? document.exitFullscreen() : instrument.value.requestFullscreen());
  } catch (error) {
    emit('error', error.message);
  }
}
onMounted(() => {
  context = display.value.getContext('2d');
  pixels = context.createImageData(256, 64);
  paint();
  canFullscreen.value = !!instrument.value.requestFullscreen;
  document.addEventListener('fullscreenchange', fullscreenChanged);
});
onBeforeUnmount(() => {
  document.removeEventListener('fullscreenchange', fullscreenChanged);
  clearTimeout(scriptTipTimer);
});
</script>

<template>
  <section
    ref="instrument"
    class="instrument"
    :class="{ 'smooth-leds': smooth, scripting: state.scripting }"
    aria-label="SQ-64 control panel"
    @pointerdown.capture="blockedInput"
    @wheel.capture="blockedInput"
  >
    <div v-if="scriptTip" id="script-lock-tip" role="status">
      A script is running — panel controls are locked until it finishes. Use its Stop script button to interrupt.
    </div>
    <div id="outputs" class="outputs" role="group" aria-label="CV and gate output indicators">
      <div
        v-for="group in OUTPUT_GROUPS"
        :key="group.label"
        class="output-group"
        role="group"
        :aria-label="`Track ${group.label} outputs`"
      >
        <span class="output-track">{{ group.label }}</span>
        <span
          v-for="output in group.outputs"
          :key="output.id"
          class="output-indicator"
          :class="{ lit: outputLevel(output.id) > 0 }"
          :data-output="output.id"
          :data-led="outputLevel(output.id)"
          role="img"
          :aria-label="`${output.name}: ${outputLevel(output.id) ? 'active' : 'off'}`"
          :title="output.name"
          :style="{ '--led-intensity': outputLevel(output.id) / 255 }"
        >
          <span class="output-lens" aria-hidden="true"></span><span aria-hidden="true">{{ output.label }}</span>
        </span>
      </div>
    </div>
    <div class="instrument-top">
      <div class="instrument-name">SQ-64<span>POLY SEQUENCER / EMULATED</span></div>
      <div id="left-knobs" class="knobs">
        <EncoderKnob
          v-for="name in ['tempo', 'swing']"
          :key="name"
          :name="name"
          :disabled="disabled"
          :position="panel?.encoders[name] || 0"
          :reset-key="resetKey"
          @input="emit('input', $event)"
        />
      </div>
      <div class="screen-wrap">
        <canvas id="display" ref="display" width="256" height="64" aria-label="Firmware display"></canvas
        ><span id="display-status">{{ displayStatus }}</span>
      </div>
      <div id="param-knobs" class="knobs">
        <EncoderKnob
          v-for="name in ['param1', 'param2', 'param3', 'param4']"
          :key="name"
          :name="name"
          :disabled="disabled"
          :position="panel?.encoders[name] || 0"
          :reset-key="resetKey"
          @input="emit('input', $event)"
        />
      </div>
    </div>
    <div class="sequencer-scroll" tabindex="0" role="group" aria-label="Sequencer buttons and 16-step grid">
      <div class="instrument-controls">
        <div v-for="(controls, id) in groups" :id="id" :key="id" class="button-row">
          <PanelButton
            v-for="control in controls"
            :key="control"
            v-bind="buttonProps(control)"
            :label="control.toUpperCase()"
            @input="emit('input', $event)"
          />
        </div>
      </div>
      <div id="matrix" class="matrix">
        <PanelButton
          v-for="button in matrix"
          :key="button.control"
          v-bind="{ ...buttonProps(button.control), ...button }"
          @input="emit('input', $event)"
        />
      </div>
    </div>
    <div class="panel-foot">
      <details class="panel-help">
        <summary>How to use the controls</summary>
        <p>Double-click any pad or button to hold or release it; pressing Enter/Space twice also works. Other than SHIFT, single clicks and pointer/keyboard holds work as usual; Shift-click also latches them.</p>
        <p id="encoder-help">Relative encoders: drag vertically, scroll, or use ← / →. Shift gives finer drag/scroll.
          Read values on the firmware display; the knob angle has no zero or reset position.</p>
      </details>
      <span class="panel-scroll-hint">Scroll sideways to reach all 16 steps</span>
      <button
        id="fullscreen"
        class="foot-button"
        :hidden="!canFullscreen"
        title="Show the control panel full screen"
        @click="toggleFullscreen"
      >
        {{ fullscreen ? 'Exit full screen' : 'Full screen' }}
      </button>
    </div>
  </section>
</template>
