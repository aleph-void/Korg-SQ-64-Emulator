<script setup>
import { watch } from 'vue';
import { KnobMotion } from './knob.js';
const props = defineProps({
  name: String,
  disabled: Boolean,
  position: { type: Number, default: 0 },
  resetKey: Number,
});
const emit = defineEmits(['input']);
const motion = new KnobMotion();
let previous;
function release() {
  previous = undefined;
  motion.reset();
}
watch(() => [props.disabled, props.resetKey], release);
function turn(delta) {
  if (delta && !props.disabled) emit('input', { type: 'encoder', control: props.name, delta });
}
function wheel(event) {
  if (props.disabled) return;
  event.preventDefault();
  turn(motion.wheel(event));
}
function key(event) {
  if (props.disabled || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  motion.reset();
  turn(event.key === 'ArrowRight' ? 1 : -1);
}
function press(event) {
  if (props.disabled) return;
  motion.reset();
  previous = event.clientY;
  event.currentTarget.setPointerCapture(event.pointerId);
}
function move(event) {
  if (previous === undefined) return;
  turn(motion.drag(previous - event.clientY, event.shiftKey));
  previous = event.clientY;
}
</script>

<template>
  <div class="knob">
    <button
      class="dial"
      :data-encoder="name"
      :aria-label="`${name} encoder`"
      :disabled="disabled"
      aria-describedby="encoder-help"
      title="Relative encoder: drag up or scroll up to increase; down to decrease. Use the firmware display for the parameter value."
      :style="{ '--rotation': `${position * 12}deg` }"
      @wheel="wheel"
      @keydown="key"
      @pointerdown="press"
      @pointermove="move"
      @pointerup="release"
      @pointercancel="release"
      @lostpointercapture="release"
      @blur="release"
    ></button>
    <label>{{ name }}</label>
  </div>
</template>
