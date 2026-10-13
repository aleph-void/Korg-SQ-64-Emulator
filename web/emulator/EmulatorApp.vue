<script setup>
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import { BrowserEmulator } from './client.js';
import { frameRenderer } from './pacing.js';
import { save } from '../src/download.js';
import DebugPanel from './DebugPanel.vue';
import WorkspaceTabs from '../src/WorkspaceTabs.vue';
import ValidationPanel from './ValidationPanel.vue';
import InstrumentPanel from './InstrumentPanel.vue';
import ScriptPanel from './ScriptPanel.vue';
import { runScript } from './scripts.js';
import { submitFirmware } from './firmware-update.js';
import { IMAGE_SIZE, parseVsb, sha256 } from '../src/protocol.js';
import { REGISTRY_URL, fetchRegistry, fetchFirmware, importEntryScripts } from './registry.js';

const activeTool = ref('firmware');
const toolTabs = computed(() => [
  { id: 'firmware', label: 'Firmware', active: state.value.updating },
  { id: 'scripts', label: 'UI scripts', active: state.value.scripting },
  { id: 'midi', label: 'MIDI' },
  { id: 'inspect', label: 'Inspect', active: state.value.report?.debug?.enabled },
]);
const sharedDevice = window.parent !== window && window.parent.sq64Emulator;
const device = sharedDevice || new BrowserEmulator();
const state = shallowRef(device.state || { loaded: false, running: false });
const panelState = shallowRef(state.value),
  resetKey = ref(0);
const route = ref('usb'),
  midiBytes = ref('90 3c 64'),
  error = ref(''),
  loading = ref(false);
const imageName = ref(state.value.loaded ? 'Current session firmware' : ''),
  loadError = ref('');
const repoEntries = shallowRef(null), repoSelected = ref(''), repoMessage = ref(''), repoBusy = ref(false);
const repoEntry = computed(() => (repoEntries.value || []).find((entry) => entry.id === repoSelected.value));
const updateImage = shallowRef(null), updateFileInfo = ref('No update firmware selected');
const updateLoading = ref(false), updateOlder = ref(false), updateMessage = ref(''), updateProgress = ref(0);
let updateController;
const controlsDisabled = computed(() => !state.value.loaded || !!state.value.terminated || !!state.value.locked || !!state.value.scripting || !!state.value.updating || loading.value || updateLoading.value);
const interactionDisabled = computed(() => controlsDisabled.value || !!state.value.report?.board.poweredOff);
const fileDisabled = computed(() => !!state.value.terminated || !!state.value.locked || !!state.value.scripting || !!state.value.updating || loading.value || updateLoading.value);
const controlState = computed(() => ({ ...state.value, locked: state.value.locked || state.value.scripting || state.value.updating || loading.value || updateLoading.value }));
const updateDisabled = computed(() => interactionDisabled.value || !updateImage.value || state.value.mode !== 'update' || !!state.value.report?.debug?.enabled || !!state.value.report?.error);
const instrumentState = computed(() => ({ ...panelState.value, locked: controlState.value.locked, scripting: !!state.value.scripting }));
const report = computed(() => state.value.report);
const status = computed(() => {
  if (state.value.terminated) return state.value.terminated.message;
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
  if (state.value.terminated && !snapshot.terminated) return;
  state.value = { ...snapshot };
  if (snapshot.terminated) {
    panelState.value = state.value;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }
  queueRender(state.value);
}
async function api(action, data = {}, scripted = false) {
  if ((device.locked || device.updating) && !['state', 'recording'].includes(action))
    throw Error('Wait for the current updater or backup operation to finish');
  if (device.scripting && !scripted && !['state', 'recording'].includes(action))
    throw Error('Stop the script before using manual controls');
  const result = await device.request(action, data);
  if (result && typeof result.loaded === 'boolean') {
    const snapshot = { ...result, locked: device.locked, scripting: device.scripting, updating: device.updating };
    update(snapshot);
    if (['load', 'reset', 'restore'].includes(action)) resetKey.value++;
    return snapshot;
  }
  return result;
}
async function playScript(script, onProgress, signal) {
  if (controlsDisabled.value) throw Error('Load firmware and wait for the current operation to finish');
  error.value = '';
  device.setScripting(true);
  resetKey.value++;
  try { return await runScript(script, { request: (action, data) => api(action, data, true), onProgress, signal,
    firmwareUpdate: updateImage.value ? (action, options) => sendUpdate(action, { ...options, scripted: true }) : undefined }); }
  finally { device.setScripting(false); }
}
async function selectUpdateFile(event) {
  if (fileDisabled.value) return;
  const file = event.target.files[0];
  updateImage.value = null;
  updateFileInfo.value = 'No update firmware selected';
  updateMessage.value = '';
  updateProgress.value = 0;
  if (!file) return;
  updateLoading.value = true;
  try {
    if (file.size !== 256 + IMAGE_SIZE) throw Error('Expected a 229,632-byte VSB system file');
    const pkg = parseVsb(await file.arrayBuffer());
    const hash = await sha256(pkg.data);
    updateImage.value = pkg.data;
    updateFileInfo.value = `${file.name} · version ${pkg.version[0]}.${String(pkg.version[1]).padStart(2, '0')} · SHA-256 ${hash}`;
  } catch (failure) {
    updateFileInfo.value = failure.message;
  } finally {
    updateLoading.value = false;
    event.target.value = '';
  }
}
async function sendUpdate(action, { signal, scripted = false, onProgress = () => {} } = {}) {
  if (!updateImage.value) throw Error('Select an update VSB file first');
  updateProgress.value = 0;
  try {
    const result = await submitFirmware(device, updateImage.value, { ...action, signal, scripted,
      onProgress(progress) {
        updateMessage.value = progress.phase === 'waiting-for-updater' ? 'Waiting for the emulator updater connection…'
          : progress.phase === 'begin' ? 'Starting firmware transfer…'
          : progress.phase === 'writing' ? 'Firmware is writing…' : 'Sending update firmware…';
        if (progress.total) updateProgress.value = 100 * progress.done / progress.total;
        onProgress(progress);
      } });
    updateMessage.value = `${result.packets} packets acknowledged. Check the emulator display for completion before restarting.`;
    return result;
  } catch (failure) {
    updateMessage.value = signal?.aborted ? 'Transfer stopped. The emulator may contain a partial update.' : `Update failed: ${failure.message}`;
    throw failure;
  }
}
async function startUpdate() {
  if (updateDisabled.value) return;
  updateController = new AbortController();
  try { await sendUpdate({ allowOlder: updateOlder.value }, { signal: updateController.signal }); }
  catch { /* sendUpdate reports the failure beside the update controls. */ }
  finally { updateController = undefined; }
}
function stopUpdate() { updateController?.abort(new DOMException('Firmware transfer stopped', 'AbortError')); }
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
    // Allow retrying a rejected file without clearing a successful selection.
    event.target.value = '';
  } finally {
    loading.value = false;
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
async function browseRepository() {
  repoBusy.value = true;
  repoMessage.value = 'Loading the firmware list…';
  try {
    const entries = await fetchRegistry();
    repoEntries.value = entries;
    if (!entries.some((entry) => entry.id === repoSelected.value)) repoSelected.value = entries[0]?.id || '';
    repoMessage.value = entries.length
      ? `${entries.length} validated firmware image${entries.length === 1 ? '' : 's'} available`
      : 'The firmware repository lists no images yet';
  } catch (failure) {
    repoMessage.value = failure.message;
  } finally {
    repoBusy.value = false;
  }
}
async function loadRepositoryFirmware() {
  const entry = repoEntry.value;
  if (!entry || fileDisabled.value) return;
  loading.value = true;
  error.value = '';
  loadError.value = '';
  try {
    repoMessage.value = `Downloading ${entry.name}…`;
    const image = await fetchFirmware(entry);
    await load(image);
    imageName.value = `${entry.name} · firmware repository`;
    repoMessage.value = `Loaded ${entry.name}. Press Power on to start.`;
  } catch (failure) {
    error.value = loadError.value = failure.message;
    repoMessage.value = failure.message;
    loading.value = false;
    return;
  } finally {
    loading.value = false;
  }
  if (!entry.scripts.length) return;
  try {
    const count = await importEntryScripts(entry);
    window.dispatchEvent(new CustomEvent('sq64-scripts-changed'));
    repoMessage.value = `Loaded ${entry.name} and imported ${count} UI script${count === 1 ? '' : 's'}. Press Power on to start.`;
  } catch (failure) {
    repoMessage.value = `Loaded ${entry.name}, but its UI scripts could not be imported: ${failure.message}`;
  }
}
function reset(mode) {
  return act(async () => {
    await api('reset', { mode });
  });
}
function restoreFirmware() {
  return act(async () => {
    await api('restore');
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
  if (device.state?.report?.critical?.installation) updateMessage.value = `Update stopped: ${event.detail}`;
}
device.addEventListener('state', stateChanged);
device.addEventListener('fault', fault);
onMounted(() => {
  if (sharedDevice) {
    observer = new ResizeObserver(() => {
      const height = Math.ceil(document.body.getBoundingClientRect().height);
      if (window.frameElement && height) window.frameElement.style.height = height + 'px';
    });
    observer.observe(document.body);
  }
});
onBeforeUnmount(() => {
  mounted = false;
  stopUpdate();
  observer?.disconnect();
  device.removeEventListener('state', stateChanged);
  device.removeEventListener('fault', fault);
  if (!sharedDevice) device.close();
});
</script>

<template>
  <header v-if="!sharedDevice" class="app-header">
    <a href="../" class="brand"><img src="../assets/aleph-void.png" alt="" />
      <span>Aleph Void<small>SQ-64 WORKSPACE</small></span></a>
    <a class="header-link" href="../?workspace=tools">Device tools ↗</a>
  </header>
  <main :class="{ embedded: sharedDevice }">
    <section v-if="state.terminated" id="safety-stop" class="safety-stop" role="alert" aria-live="assertive">
      <h2>Do not flash this firmware to a real device.</h2>
      <p>{{ state.terminated.message }}</p>
      <p v-for="result in state.terminated.tests" :key="result.id">
        {{ result.id }}: {{ result.operation || result.title || result.detail }}
        <span v-if="result.address != null">at 0x{{ result.address.toString(16) }}</span>
      </p>
      <p style="overflow-wrap: anywhere">Firmware SHA-256: {{ state.terminated.imageSha256 }}</p>
      <p>Execution and MIDI are terminated for this session. Save the reports below to investigate the firmware.</p>
    </section>
    <div class="heading">
      <div>
        <p class="eyebrow">FIRMWARE WORKSPACE</p>
        <h1>SQ-64 emulator</h1>
      </div>
      <span class="engine-label" id="engine">WebAssembly <span aria-hidden="true">/</span> Cortex-M7</span>
    </div>
    <section class="session-bar" aria-label="Firmware and power">
      <div class="session-image">
        <span class="session-icon" aria-hidden="true">▤</span>
        <div class="session-file">
          <span class="field-caption">FIRMWARE IMAGE</span>
          <strong :title="imageName">{{ imageName || 'Choose a firmware image to begin' }}</strong>
          <p id="image-status" role="status" :class="{ 'sr-only': imageName && !loading && !loadError }" :hidden="!loading && !loadError && !imageName">
            {{ loading ? 'Loading firmware…' : loadError || `Loaded: ${imageName}` }}
          </p>
          <span v-if="!imageName && !loadError && !loading" class="file-hint">Local VSB, BIN or ELF · files stay on this computer</span>
        </div>
      </div>
      <label class="file-button" :class="{ disabled: fileDisabled, primary: !state.loaded }">{{ imageName ? 'Change firmware' : 'Load firmware' }}
        <input type="file" id="image" :disabled="fileDisabled" @change="loadFile" />
      </label>
      <div class="session-power">
        <button id="reset" class="primary" :disabled="controlsDisabled" title="Start in normal mode. Restarts immediately if already running." @click="reset('normal')">
          <span aria-hidden="true">⏻</span> {{ state.running ? 'Restart' : 'Power on' }}
        </button>
        <button id="poweroff" :disabled="interactionDisabled" title="Hold the power button until firmware finishes saving" @click="act(() => api('poweroff'))">Power off</button>
      </div>
    </section>
    <div class="execution-bar">
      <div class="session-status">
        <span class="status-dot" :class="{ running: state.running, fault: error || state.terminated || report?.error }" aria-hidden="true"></span>
        <div id="status" role="status">{{ status }}</div>
      </div>
      <div class="execution-actions">
        <button v-if="state.scripting || state.updating" class="activity-link" @click="activeTool = state.scripting ? 'scripts' : 'firmware'">
          {{ state.scripting ? 'Script running ↘' : 'Firmware transfer ↘' }}
        </button>
        <button id="run" :hidden="state.running" :disabled="interactionDisabled" @click="act(() => api('run'))">Run</button>
        <button id="pause" :hidden="!state.running" :disabled="interactionDisabled" @click="act(() => api('pause'))">Pause</button>
      </div>
    </div>
    <InstrumentPanel :state="instrumentState" :reset-key="resetKey"
      @input="act(() => api('event', $event))" @error="error = $event" />
    <p v-if="!state.loaded" class="getting-started">Start with your firmware file, then choose <strong>Power on</strong>. First startup can take a minute or more.</p>
    <div class="workbench-tools">
      <WorkspaceTabs v-model="activeTool" :tabs="toolTabs" prefix="workbench" label="Emulator tools" />
      <section id="workbench-firmware" role="tabpanel" aria-labelledby="workbench-tab-firmware" :hidden="activeTool !== 'firmware'" tabindex="0">
        <div class="tool-grid">
          <section class="tool-card">
            <h2>Firmware library</h2>
            <p>Load a local image above, or explore community builds.</p>
            <div class="firmware-repo">
              <button id="repo-browse" :disabled="repoBusy" @click="browseRepository">
                {{ repoEntries ? 'Refresh firmware repository' : 'Browse firmware repository' }}</button
              ><template v-if="repoEntries && repoEntries.length">
                <label
                  >Community firmware<select id="repo-list" v-model="repoSelected" :disabled="repoBusy || fileDisabled">
                    <option v-for="entry in repoEntries" :key="entry.id" :value="entry.id">{{ entry.name }}</option>
                  </select></label
                ><button id="repo-load" :disabled="fileDisabled || !repoEntry" @click="loadRepositoryFirmware">
                  Load selected firmware
                </button>
              </template>
              <p v-if="repoEntry" class="hint">
                {{ repoEntry.description }}
                <a :href="repoEntry.repo" target="_blank" rel="noopener noreferrer">Source at {{ repoEntry.ref?.slice(0, 12) }}</a
                ><template v-if="repoEntry.validation">
                  · <a :href="REGISTRY_URL + repoEntry.validation" target="_blank" rel="noopener noreferrer">Validation report</a></template
                ><template v-if="repoEntry.scripts.length">
                  · ships {{ repoEntry.scripts.length }} UI script{{ repoEntry.scripts.length === 1 ? '' : 's' }}, imported into UI
                  scripts tab on load</template
                >
              </p>
              <p v-if="repoEntries" class="hint">
                Community images are built from pinned public sources and validated by the
                <a href="https://github.com/aleph-void/Korg-SQ-64-Custom-Firmware-Repo" target="_blank" rel="noopener noreferrer"
                  >firmware repository</a
                >
                pipeline before publication. Passing validation does not make an image safe to flash on a real device.
              </p>
              <p id="repo-status" role="status" :hidden="!repoMessage">{{ repoMessage }}</p>
            </div>
            <p class="source-link"><a href="https://www.korg.com/us/support/download/software/0/872/4737/" target="_blank" rel="noopener noreferrer">Korg download and terms ↗</a>
              <span>Extract the .VSB from the official updater ZIP.</span></p>
            <details class="sub-details"><summary>Try the emulator without vendor firmware</summary>
              <p class="hint">Original test firmware with synthetic backup data and update staging. It is not deployable SQ-64 firmware.</p>
              <button id="load-probe" :disabled="fileDisabled" @click="loadProbe">Load original integration probe</button>
            </details>
          </section>
          <section class="tool-card">
            <h2>Startup &amp; recovery</h2>
            <p>Start with a button combination held, then release it when the display appears.</p>
            <div class="toolbar"><div>
              <button id="version" title="Power on with GLOBAL held" :disabled="controlsDisabled" @click="reset('version')">Version mode</button>
              <button id="update" title="Power on with GLOBAL and PATTERN held" :disabled="controlsDisabled" @click="reset('update')">Update mode</button>
              <button id="release" :disabled="interactionDisabled" @click="releaseStartup">Release startup buttons</button>
            </div></div>
            <label class="route-field">MIDI route for next load<select id="midi-route" v-model="route" :disabled="fileDisabled">
              <option value="usb">USB sequencer</option><option value="din">DIN MIDI (test probe)</option>
            </select></label>
            <details class="sub-details"><summary>Restore the original image</summary>
              <p class="hint">Discards saved projects, settings and staged updates in this session. Power off and wait for shutdown before a normal restart to preserve projects.</p>
              <button id="restore-firmware" :disabled="controlsDisabled" @click="restoreFirmware">Restore firmware</button>
            </details>
          </section>
        </div>
        <details id="firmware-update" class="scripts">
          <summary>Send a second firmware image</summary>
          <p>Start the loaded firmware in Update mode, then select a second .VSB and send it to the running updater.</p>
          <label>Update firmware (.VSB)<input id="update-image" type="file" :disabled="fileDisabled" @change="selectUpdateFile" /></label>
          <p id="update-file-info" style="overflow-wrap: anywhere">{{ updateLoading ? 'Reading update firmware…' : updateFileInfo }}</p>
          <label><input id="update-older" type="checkbox" v-model="updateOlder" :disabled="fileDisabled" />Allow reinstalling the same version or downgrading</label>
          <div class="toolbar"><div>
            <button id="send-update" :disabled="updateDisabled" @click="startUpdate">Send update firmware</button>
            <button id="stop-update" :disabled="!state.updating || state.scripting" @click="stopUpdate">Stop transfer</button>
          </div></div>
          <progress aria-label="Firmware transfer progress" max="100" :value="updateProgress"></progress>
          <p id="update-status" role="status">{{ updateMessage || 'Ready after selecting an update file and starting Update mode' }}</p>
          <p class="hint">Files stay in memory. Scripts use this selection for the firmware-update action.
            Packet acknowledgement does not verify installation. The selected image's installation writes are permitted;
            unexpected protected writes still stop execution.</p>
        </details>
      </section>
      <section id="workbench-scripts" role="tabpanel" aria-labelledby="workbench-tab-scripts" :hidden="activeTool !== 'scripts'" tabindex="0">
        <ScriptPanel :state="state" :loading="loading || updateLoading" :play="playScript" />
      </section>
      <section id="workbench-midi" role="tabpanel" aria-labelledby="workbench-tab-midi" :hidden="activeTool !== 'midi'" tabindex="0">
        <div class="tool-heading"><h2>MIDI monitor</h2><p>Send messages to the running firmware and inspect its output.</p></div>
        <div class="details midi-details">
          <section>
            <p class="eyebrow">MESSAGES</p>
            <label>Inject MIDI bytes (hex)<input id="midi-bytes" spellcheck="false" v-model="midiBytes" /></label
            ><button id="send-midi" :disabled="interactionDisabled" @click="sendMidi">Send to firmware</button>
            <pre id="midi-log">{{ midiLog }}</pre>
          </section>
          <section><p class="eyebrow">CONNECTION</p><p>{{ midi }}</p>
            <p class="hint">The MIDI route is chosen when loading firmware. Configure it in the Firmware tab before loading a new image.</p>
          </section>
        </div>
      </section>
      <section id="workbench-inspect" role="tabpanel" aria-labelledby="workbench-tab-inspect" :hidden="activeTool !== 'inspect'" tabindex="0">
        <div class="tool-heading"><h2>Inspect firmware</h2><p>Validate the loaded image, inspect execution, or step through instructions.</p></div>
        <ValidationPanel :state="controlState" :request="api" />
        <div class="details">
          <section>
            <p class="eyebrow">EXECUTION</p>
            <div class="toolbar"><button id="step" :disabled="interactionDisabled" @click="act(() => api('step', { instructions: 1000 }))">Step 1,000</button></div>
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
            ><button id="recording" :disabled="!!state.terminated" @click="act(async () => save(await device.request('recording'), 'sq64-inputs.json'))">
              Save input recording</button
            ><label>Replay recording<input id="replay" type="file" accept=".json" :disabled="controlsDisabled" @change="replay" /></label>
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
              immediately; closing the page discards this session. Restore firmware discards saved projects, settings and
              staged updates, returning the device to the originally loaded image.
            </p>
          </section>
        </div>
        <DebugPanel :state="controlState" :request="api" />
      </section>
    </div>
    <footer v-if="!sharedDevice">
      <span>Aleph Void · Independent tools. Not affiliated with Korg.</span
      ><span>Linux · macOS · Windows / no vendor firmware bundled</span
      ><span
        ><a href="../LICENSE" target="_blank" rel="noopener">GPLv2 license</a> ·
        <a href="https://github.com/aleph-void/Korg-SQ-64-Emulator" target="_blank" rel="noopener noreferrer"
          >Emulator source</a
        >
        ·
        <a href="https://github.com/aleph-void/Korg-SQ-64-Custom-Firmware-Spec" target="_blank" rel="noopener noreferrer"
          >Firmware spec</a
        >
        ·
        <a href="https://github.com/aleph-void/Korg-SQ-64-Custom-Firmware-Repo" target="_blank" rel="noopener noreferrer"
          >Firmware repository</a
        >
        · <a href="../vendor/unicorn-arm-source.tar.gz">Unicorn source</a></span
      >
    </footer>
  </main>
</template>
