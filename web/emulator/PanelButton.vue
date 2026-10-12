<script setup>
import { ref, watch } from 'vue';
const props = defineProps({
  control: String,
  label: String,
  pad: Boolean,
  disabled: Boolean,
  down: Boolean,
  level: { type: Number, default: 0 },
  resetKey: Number,
});
const emit = defineEmits(['input']);
const pressed = ref(props.down),
  latched = ref(false);
let held = false;
watch(
  () => props.down,
  (value) => {
    pressed.value = value;
  },
);
watch(
  () => props.resetKey,
  () => {
    held = false;
    latched.value = false;
    pressed.value = props.down;
  },
);
function send(down) {
  held = down;
  pressed.value = down;
  emit('input', { type: 'button', control: props.control, down });
}
function press(event) {
  if (props.disabled) return;
  event.preventDefault();
  event.currentTarget.setPointerCapture(event.pointerId);
  if (event.shiftKey) {
    latched.value = !latched.value;
    send(latched.value);
  } else send(true);
}
function release() {
  if (!latched.value && held) send(false);
}
function key(event, down) {
  if (props.disabled || ![' ', 'Enter'].includes(event.key)) return;
  event.preventDefault();
  if (!event.repeat) send(down);
}
</script>

<template>
  <button
    :class="[pad ? 'pad' : 'control', { lit: level > 0 }]"
    :data-control="control"
    :disabled="disabled"
    :aria-label="pad ? `Pad ${control}` : label"
    :aria-pressed="pressed"
    :data-latched="latched"
    :data-led="level"
    :aria-description="level > 0 ? 'Firmware indicator lit' : 'Firmware indicator off'"
    :style="{ '--led-intensity': level / 255 }"
    @pointerdown="press"
    @pointerup="release"
    @pointercancel="release"
    @lostpointercapture="release"
    @keydown="key($event, true)"
    @keyup="key($event, false)"
  >
    {{ label }}
  </button>
</template>
