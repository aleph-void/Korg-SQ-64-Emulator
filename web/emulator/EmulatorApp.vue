<script setup>
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import { BrowserEmulator } from './client.js';
import { frameRenderer } from './pacing.js';
import { save } from '../src/download.js';
import DebugPanel from './DebugPanel.vue';
import ValidationPanel from './ValidationPanel.vue';
import InstrumentPanel from './InstrumentPanel.vue';

const sharedDevice = window.parent !== window && window.parent.sq64Emulator;
const device = sharedDevice || new BrowserEmulator();
const state = shallowRef(device.state || { loaded: false, running: false });
const panelState = shallowRef(state.value),
  resetKey = ref(0);
const route = ref('usb'),
  midiBytes = ref('90 3c 64'),
  error = ref(''),
  loading = ref(false);
const imageName = ref(''),
  loadError = ref('');
const controlsDisabled = computed(() => !state.value.loaded || !!state.value.locked || loading.value);
const interactionDisabled = computed(() => controlsDisabled.value || !!state.value.report?.board.poweredOff);
const fileDisabled = computed(() => !!state.value.locked || loading.value);
const report = computed(() => state.value.report);
const status = computed(() => {
  if (loading.value) return 'Loading firmware…';
  if (error.value) return error.value;
  if (!state.value.loaded) return 'Load your own firmware to begin.';
  const r = report.value;
  return (
    r.error ||
    (r.debug?.stoppedAt != null
      ? `Breakpoint at 0x${r.debug.stoppedAt.toString(16).padStart(8, '0')}`
      : r.board.poweredOff
        ? 'Powered off · firmware finished shutdown'
        : !state.value.running && r.board.ticks === 0
          ? 'Firmware loaded · press Power on to start'
          : state.value.running && state.value.panel.displayFrames === 0
            ? 'Running · starting firmware; waiting for the first display frame'
            : `${state.value.running ? 'Running' : 'Paused'} · ${state.value.mode} startup`)
  );
});
const pc = computed(() => (report.value ? `0x${report.value.pc.toString(16).padStart(8, '0')}` : '—'));
const midi = computed(() =>
  typeof state.value.midi === 'string' ? state.value.midi : state.value.midi?.name || 'Disabled',
);
const midiLog = computed(
  () =>
    report.value?.board.midiOut
      .slice(-32)
      .map((packet) => `${packet.tick}: ${packet.byte.toString(16).padStart(2, '0')}`)
      .join('\n') || 'No output',
);
let mounted = true,
  observer;
const queueRender = frameRenderer((snapshot) => {
  if (mounted) panelState.value = snapshot;
});
function update(snapshot) {
  state.value = { ...snapshot };
  queueRender(state.value);
}
async function api(action, data = {}) {
  if (device.locked && !['state', 'recording'].includes(action))
    throw Error('Wait for the current updater or backup operation to finish');
  const result = await device.request(action, data);
  if (result && typeof result.loaded === 'boolean') update({ ...result, locked: device.locked });
  return result;
}
async function act(task) {
  error.value = '';
  try {
    return await task();
  } catch (failure) {
    error.value = failure.message;
  }
}
async function load(bytes) {
  await api('load', { bytes, transport: route.value });
  resetKey.value++;
}
async function loadFile(event) {
  const file = event.target.files[0];
  if (!file || fileDisabled.value) return;
  loading.value = true;
  error.value = '';
  loadError.value = '';
  try {
    if (file.size > 4 * 1024 * 1024) throw Error('Image exceeds 4 MiB');
    await load(await file.arrayBuffer());
    imageName.value = file.name;
  } catch (failure) {
    error.value = loadError.value = failure.message;
  } finally {
    loading.value = false;
    // Let the same file be selected again after an error or a local edit.
    event.target.value = '';
  }
}
async function loadProbe() {
  if (fileDisabled.value) return;
  loading.value = true;
  error.value = '';
  loadError.value = '';
  try {
    route.value = 'din';
    const response = await fetch('../examples/browser-probe.bin');
    if (!response.ok) throw Error('Integration probe is unavailable');
    await load(await response.arrayBuffer());
    imageName.value = 'Original integration probe';
    await api('run');
  } catch (failure) {
    error.value = loadError.value = failure.message;
  } finally {
    loading.value = false;
  }
}
function reset(mode) {
  return act(async () => {
    await api('reset', { mode });
    resetKey.value++;
  });
}
function releaseStartup() {
  return act(async () => {
    for (const control of ['global', 'pattern']) await api('event', { type: 'button', control, down: false });
    resetKey.value++;
  });
}
function sendMidi() {
  return act(() => {
    const text = midiBytes.value.trim();
    if (!/^[0-9a-f]{2}(\s+[0-9a-f]{2})*$/i.test(text)) throw Error('Enter hexadecimal bytes separated by spaces');
    return api('event', { type: 'midi', data: text.split(/\s+/).map((value) => parseInt(value, 16)) });
  });
}
function replay(event) {
  const file = event.target.files[0];
  if (file) return act(async () => api('replay', JSON.parse(await file.text())));
}
function stateChanged(event) {
  update(event.detail);
}
function fault(event) {
  error.value = event.detail;
}
device.addEventListener('state', stateChanged);
device.addEventListener('fault', fault);
onMounted(() => {
  if (sharedDevice) {
    observer = new ResizeObserver(() => {
      if (window.frameElement) window.frameElement.style.height = document.documentElement.scrollHeight + 'px';
    });
    observer.observe(document.body);
  }
});
onBeforeUnmount(() => {
  mounted = false;
  observer?.disconnect();
  device.removeEventListener('state', stateChanged);
  device.removeEventListener('fault', fault);
  if (!sharedDevice) device.close();
});
</script>

<template>
  <header hidden>
    <a href="https://alephvoid.com" class="brand"
      ><img src="../assets/aleph-void.png" alt="" /><span>Aleph Void<small>SQ-64 / FIRMWARE WORKBENCH</small></span></a
    ><span class="badge" id="engine">CORTEX-M7 · WEBASSEMBLY</span>
  </header>
  <main>
    <div class="heading">
      <div>
        <p class="eyebrow">BUILD. PLAY. INSPECT.</p>
        <h1>Browser firmware workbench.</h1>
        <p>Load firmware here, then press Power on. First startup can take a minute or more.</p>
      </div>
      <label class="file-button"
        >Load firmware<input
          type="file"
          id="image"
          accept=".bin,.vsb,.VSB,.elf"
          :disabled="fileDisabled"
          @change="loadFile"
      /></label>
    </div>
    <p id="image-status" role="status" :hidden="!loading && !loadError && !imageName">
      {{ loading ? 'Loading firmware…' : loadError || `Loaded: ${imageName}` }}
    </p>
    <div class="official-firmware">
      <a href="https://www.korg.com/us/support/download/software/0/872/4737/" target="_blank" rel="noopener noreferrer"
        >Korg download and terms</a
      >
      <p>
        Download the official updater ZIP from Korg, extract the .VSB file, and load it with the firmware button above.
      </p>
    </div>
    <label
      >MIDI route<select id="midi-route" v-model="route" :disabled="fileDisabled">
        <option value="usb">USB sequencer</option>
        <option value="din">DIN MIDI (test probe)</option>
      </select></label
    ><button id="load-probe" :disabled="fileDisabled" @click="loadProbe">Load original integration probe</button>
    <p class="hint">
      The probe is original test firmware for this emulator. It stages incoming updates in emulated flash and returns
      synthetic backup data. It is not deployable SQ-64 firmware.
    </p>
    <div class="toolbar">
      <div>
        <button id="run" :disabled="interactionDisabled" @click="act(() => api('run'))">Run</button
        ><button id="pause" :disabled="interactionDisabled" @click="act(() => api('pause'))">Pause</button
        ><button id="step" :disabled="interactionDisabled" @click="act(() => api('step', { instructions: 1000 }))">
          Step 1,000
        </button>
      </div>
      <div>
        <button
          id="poweroff"
          title="Hold the power button until firmware finishes saving"
          :disabled="interactionDisabled"
          @click="act(() => api('poweroff'))"
        >
          Power off</button
        ><button id="reset" :disabled="controlsDisabled" @click="reset('normal')">Power on</button
        ><button id="version" title="Power on with GLOBAL held" :disabled="controlsDisabled" @click="reset('version')">
          Version mode</button
        ><button
          id="update"
          title="Power on with GLOBAL and PATTERN held"
          :disabled="controlsDisabled"
          @click="reset('update')"
        >
          Update mode</button
        ><button id="release" :disabled="interactionDisabled" @click="releaseStartup">Release startup buttons</button>
      </div>
    </div>
    <ValidationPanel :state="state" :request="api" />
    <InstrumentPanel
      :state="panelState"
      :reset-key="resetKey"
      @input="act(() => api('event', $event))"
      @error="error = $event"
    />
    <div class="details">
      <section>
        <p class="eyebrow">EXECUTION</p>
        <div id="status" role="status">{{ status }}</div>
        <dl>
          <dt>Program counter</dt>
          <dd id="pc">{{ pc }}</dd>
          <dt>Instructions</dt>
          <dd id="ticks">{{ report?.board.ticks.toLocaleString() || '0' }}</dd>
          <dt>Interrupts delivered</dt>
          <dd id="irq">{{ report?.interrupts.delivered || 0 }}</dd>
          <dt>MIDI endpoint</dt>
          <dd id="midi">{{ midi }}</dd>
        </dl>
        <button id="report" :disabled="!state.loaded" @click="save(report, 'sq64-execution.json')">
          Save execution report</button
        ><button id="recording" @click="act(async () => save(await device.request('recording'), 'sq64-inputs.json'))">
          Save input recording</button
        ><label>Replay recording<input id="replay" type="file" accept=".json" @change="replay" /></label>
      </section>
      <section>
        <p class="eyebrow">MODEL COVERAGE</p>
        <p>
          The core executes the supplied ARM firmware. Virtual time is deterministic, not cycle accurate. Unverified
          board wiring and peripheral behavior remain explicit below.
        </p>
        <ul id="limitations">
          <li v-for="limitation in report?.board.approximations || ['No firmware loaded']" :key="limitation">
            {{ limitation }}
          </li>
        </ul>
        <p class="hint">
          Version holds GLOBAL at power-on; Update holds GLOBAL + PATTERN. Release the startup buttons after the screen
          appears. Use Power off and wait for shutdown before restarting to preserve projects. Power on resets
          immediately; closing the page discards this session.
        </p>
      </section>
      <section>
        <p class="eyebrow">MIDI MONITOR</p>
        <label>Inject USB MIDI bytes<input id="midi-bytes" spellcheck="false" v-model="midiBytes" /></label
        ><button id="send-midi" :disabled="interactionDisabled" @click="sendMidi">Send to firmware</button>
        <pre id="midi-log">{{ midiLog }}</pre>
      </section>
    </div>
    <DebugPanel :state="state" :request="api" />
    <footer>
      <span>Aleph Void · Independent tools. Not affiliated with Korg.</span
      ><span>Linux · macOS · Windows / no vendor firmware bundled</span
      ><span
        ><a href="../LICENSE" target="_blank" rel="noopener">GPLv2 license</a> ·
        <a href="https://github.com/aleph-void/Korg-SQ-64-Emulator" target="_blank" rel="noopener noreferrer"
          >Source code</a
        >
        · <a href="../vendor/unicorn-arm-source.tar.gz">Unicorn source</a></span
      >
    </footer>
  </main>
</template>
