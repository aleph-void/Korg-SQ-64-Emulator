<script setup>
import { onBeforeUnmount, ref, watch } from 'vue';
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
  latched = ref(false),
  showTip = ref(false);
let held = false, presses = [], tipTimer, lastKeyPress = -Infinity;
function clearTip() { clearTimeout(tipTimer); showTip.value = false; presses = []; }
function notePress() {
  const now = performance.now();
  presses = presses.filter(time => now - time <= 2000);
  presses.push(now);
  if (presses.length > 3) {
    showTip.value = true;
    clearTimeout(tipTimer);
    tipTimer = setTimeout(clearTip, 6000);
  }
}
onBeforeUnmount(clearTip);
watch(() => props.disabled, clearTip);
watch(
  () => props.down,
  (value) => {
    pressed.value = value;
  },
);
watch(
  () => props.resetKey,
  () => {
    clearTip();
    held = false;
    lastKeyPress = -Infinity;
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
  notePress();
  // SHIFT is a double-click toggle. Do not also send the constituent taps:
  // firmware can interpret those as its own double-tap latch gesture.
  if (props.control === 'shift') return;
  if (event.shiftKey) {
    latched.value = !latched.value;
    send(latched.value);
  } else if (!latched.value) send(true);
}
function doubleClick(event) {
  if (props.disabled) return;
  event.preventDefault();
  lastKeyPress = -Infinity;
  latched.value = !latched.value;
  send(latched.value);
}
function release() {
  if (!latched.value && held) send(false);
}
function key(event, down) {
  if (event.key === 'Escape') clearTip();
  if (props.disabled || ![' ', 'Enter'].includes(event.key)) return;
  event.preventDefault();
  if (!event.repeat) {
    if (down) {
      notePress();
      const now = performance.now();
      if (now - lastKeyPress <= 500) doubleClick(event);
      else {
        lastKeyPress = now;
        if (props.control !== 'shift' && !latched.value) send(true);
      }
    }
    else release();
  }
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
    :aria-describedby="showTip ? `${control}-latch-tip` : undefined"
    :title="`Double-click ${pad ? `Pad ${control}` : label}, or press Enter/Space twice, to latch or release it.`"
    :data-led="level"
    :aria-description="level > 0 ? 'Firmware indicator lit' : 'Firmware indicator off'"
    :style="{ '--led-intensity': level / 255 }"
    @pointerdown="press"
    @dblclick="doubleClick"
    @pointerup="release"
    @pointercancel="release"
    @lostpointercapture="release"
    @keydown="key($event, true)"
    @keyup="key($event, false)"
  >
    {{ label }}
    <span v-if="showTip" :id="`${control}-latch-tip`" class="latch-tip" role="tooltip">Double-click {{ pad ? `Pad ${control}` : label }} to toggle its latched state.</span>
  </button>
</template>
