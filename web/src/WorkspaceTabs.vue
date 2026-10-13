<script setup>
const props = defineProps({
  modelValue: { type: String, required: true },
  tabs: { type: Array, required: true },
  prefix: { type: String, required: true },
  label: { type: String, required: true },
});
const emit = defineEmits(['update:modelValue']);
function navigate(event, index) {
  const last = props.tabs.length - 1;
  const next = { ArrowRight: (index + 1) % props.tabs.length, ArrowLeft: (index + last) % props.tabs.length,
    Home: 0, End: last }[event.key];
  if (next === undefined) return;
  event.preventDefault();
  emit('update:modelValue', props.tabs[next].id);
  event.currentTarget.parentElement.querySelectorAll('[role=tab]')[next].focus();
}
</script>

<template>
  <div class="workspace-tabs" role="tablist" :aria-label="label">
    <button v-for="(tab, index) in tabs" :id="`${prefix}-tab-${tab.id}`" :key="tab.id"
      type="button" role="tab" :aria-selected="modelValue === tab.id" :aria-controls="`${prefix}-${tab.id}`"
      :tabindex="modelValue === tab.id ? 0 : -1" @click="emit('update:modelValue', tab.id)" @keydown="navigate($event, index)">
      {{ tab.label }}<span v-if="tab.active" class="tab-activity" aria-label="active"></span>
    </button>
  </div>
</template>

<style scoped>
.workspace-tabs { display: flex; gap: 24px; border-bottom: 1px solid #30303b; overflow-x: auto; }
.workspace-tabs button { flex-shrink: 0; display: flex; align-items: center; gap: 8px; position: relative; padding: 16px 2px;
  background: transparent; border: 0; border-radius: 0; color: #a1a1aa; font-size: 12px; font-weight: 500; }
.workspace-tabs button:hover { color: #eeeaf6; background: transparent; }
.workspace-tabs button[aria-selected=true] { color: #d7c8ff; }
.workspace-tabs button[aria-selected=true]::after { content: ''; position: absolute; bottom: 0; left: 0; right: 0; height: 2px; background: #a78bfa; }
.workspace-tabs button:focus-visible { outline-offset: -3px; }
.tab-activity { width: 5px; height: 5px; border-radius: 50%; background: #a78bfa; }
@media (max-width: 680px) { .workspace-tabs { gap: 22px; } .workspace-tabs button { min-height: 48px; } }
</style>
