<script setup>
import { computed, ref, watch } from 'vue';
import { save } from '../src/download.js';
import { criticalStop } from './conformance/safety.js';
const props = defineProps({ state: { type: Object, required: true }, request: { type: Function, required: true } });
const busy = ref(false),
  message = ref('');
const report = computed(() => props.state.report?.conformance);
const unsafe = computed(() => criticalStop(report.value));
const summary = computed(() =>
  report.value
    ? `${unsafe.value ? 'UNSAFE' : report.value.status.toUpperCase()} · ${report.value.counts.pass} passed · ${report.value.counts.fail} failed · ${report.value.counts['not-run']} not run`
    : props.state.loaded
      ? 'Ready to validate the loaded file.'
      : 'Load firmware to validate its image.',
);
watch(
  () => JSON.stringify(report.value),
  () => {
    message.value = '';
  },
);
async function validate() {
  if (busy.value) return;
  busy.value = true;
  message.value = '';
  try {
    await props.request('validate');
  } catch (error) {
    message.value = error.message;
  } finally {
    busy.value = false;
  }
}
function saveReport() {
  if (report.value) save(report.value, 'sq64-conformance.json');
}
</script>

<template>
  <section class="validation" aria-label="Image conformance">
    <div class="toolbar">
      <div>
        <button id="validate-image" :disabled="busy || !state.loaded || state.terminated || state.locked" @click="validate">
          {{ busy ? 'Validating…' : 'Validate Image' }}</button
        ><button id="validation-save" :disabled="busy || !report" @click="saveReport">Save validation report</button>
      </div>
    </div>
    <p>
      Run the
      <a href="https://github.com/aleph-void/Korg-SQ-64-Custom-Firmware-Spec" target="_blank" rel="noopener noreferrer"
        >SQ-64 conformance spec</a
      >
      image profile on the loaded file. A passing critical damage detector immediately terminates the emulator.
      Other results leave execution and debugger settings untouched.
    </p>
    <p id="validation-summary" role="status">{{ summary }}</p>
    <p id="validation-message" role="alert">{{ message }}</p>
    <div id="validation-results" v-if="report">
      <p id="validation-source">
        {{ `Spec ${report.specVersion} · image profile · revision ${report.specSource.revision.slice(0, 12)}` }}
      </p>
      <p id="validation-hash">{{ `Loaded file SHA-256: ${report.imageSha256}` }}</p>
      <p id="validation-format" :hidden="report.results.find((row) => row.id === 'PKG-001')?.status === 'pass'">
        The image profile requires a complete VSB package. Raw BIN and ELF files cannot pass this profile; package
        checks are not inferred from emulated memory.
      </p>
      <div class="validation-table">
        <table>
          <thead>
            <tr>
              <th scope="col">Requirement</th>
              <th scope="col">Result</th>
              <th scope="col">Details</th>
            </tr>
          </thead>
          <tbody id="validation-rows">
            <tr v-for="row in report.results" :key="row.id" :data-status="row.status" :data-unsafe="!!unsafe?.tests.some(test => test.id === row.id)">
              <td>{{ row.id }}</td>
              <td>{{ unsafe?.tests.some(test => test.id === row.id) ? 'PASS · UNSAFE' : row.status.toUpperCase() }}</td>
              <td>{{ row.detail }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    <p class="hint">
      Results cover the exact file selected at load time, including after a reset. Runtime writes and installed updates
      are not re-packaged as a VSB. Software behavior and physical hardware conformance require separate evidence.
      Validation is included in execution and debug reports.
    </p>
  </section>
</template>
