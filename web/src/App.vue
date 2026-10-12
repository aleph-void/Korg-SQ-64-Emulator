<script setup>
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { parseVsb, sha256 } from './protocol.js';
import { MidiSession, updateFirmware } from './session.js';
import { createBackup, validateBackup, restoreBackup } from './backup.js';
import { DemoSession } from './demo.js';
import { BrowserEmulator } from '../emulator/client.js';
import { save } from './download.js';

const version = __APP_VERSION__;
const emulator = new BrowserEmulator();
const safetyStop = shallowRef(null);
window.sq64Emulator = emulator;
let access,
  session,
  emulatorSelected = false,
  fileRevision = 0,
  backupRevision = 0;
const firmware = shallowRef(null),
  archive = shallowRef(null);
const busy = ref(false),
  awaitingCompletion = ref(false),
  scripting = ref(false),
  connected = ref(false);
const locked = computed(() => busy.value || awaitingCompletion.value || scripting.value);
const tab = ref('backup'),
  channel = ref(0),
  scope = ref('all');
const ready = ref(false),
  older = ref(false),
  restoreReady = ref(false);
const inputId = ref(''),
  outputId = ref(''),
  inputs = ref([]),
  outputs = ref([]),
  portsVisible = ref(false);
const connectionState = ref('No device connected'),
  modeNote = ref('');
const status = ref('Ready when you are'),
  progress = ref(0),
  percent = ref(''),
  logText = ref('');
const fileInfo = ref('No firmware selected'),
  backupInfo = ref('No backup selected');
const workbenchOpen = ref(false),
  workbench = ref(null),
  logElement = ref(null);
watch(() => busy.value || awaitingCompletion.value, (value) => emulator.setLocked(value), { flush: 'sync' });
function emulatorState(event) { scripting.value = !!event.detail.scripting; }
emulator.addEventListener('state', emulatorState);
watch(logText, async () => {
  await nextTick();
  if (logElement.value) logElement.value.scrollTop = logElement.value.scrollHeight;
});
const log = (text) => {
  logText.value += `${text}\n`;
};
function refreshConnection() {
  connected.value = !!session && !session.closed;
  if (session?.closed) connectionState.value = 'Device disconnected';
}
function closeSession() {
  session?.input?.removeEventListener('statechange', refreshConnection);
  session?.output?.removeEventListener('statechange', refreshConnection);
  session?.close();
  refreshConnection();
}
function selectSession(next) {
  session = next;
  session.input?.addEventListener('statechange', refreshConnection);
  session.output?.addEventListener('statechange', refreshConnection);
  refreshConnection();
}
async function operation(task) {
  if (locked.value || !connected.value) return;
  busy.value = true;
  logText.value = '';
  progress.value = 0;
  percent.value = '';
  let wake;
  try {
    try {
      wake = await navigator.wakeLock?.request('screen');
    } catch {
      /* Optional convenience. */
    }
    await task();
  } catch (error) {
    status.value = 'Operation stopped';
    log(error.message);
  } finally {
    try {
      await wake?.release();
    } catch {
      /* The browser may already have released it. */
    }
    busy.value = false;
    refreshConnection();
    if (access) portOptions();
  }
}
function beforeUnload(event) {
  if (locked.value) {
    event.preventDefault();
    event.returnValue = '';
  }
}
window.addEventListener('beforeunload', beforeUnload);
function portOptions() {
  if (locked.value) return;
  const list = (ports) =>
    [...ports.values()]
      .filter((port) => port.state === 'connected')
      .map((port) => ({ id: port.id, label: `${port.name || 'MIDI port'} · ${port.manufacturer || 'unknown'}` }));
  inputs.value = list(access.inputs);
  outputs.value = list(access.outputs);
  if (!inputs.value.some((port) => port.id === inputId.value)) inputId.value = inputs.value[0]?.id || '';
  if (!outputs.value.some((port) => port.id === outputId.value)) outputId.value = outputs.value[0]?.id || '';
}
function portsChanged() {
  portOptions();
  refreshConnection();
}
async function enableMidi() {
  try {
    if (!window.isSecureContext || !navigator.requestMIDIAccess)
      throw Error('Web MIDI is unavailable. Use a supported desktop browser over HTTPS or localhost.');
    const next = await navigator.requestMIDIAccess({ sysex: true });
    if (!next.sysexEnabled) throw Error('SysEx permission is required');
    access?.removeEventListener('statechange', portsChanged);
    access = next;
    access.addEventListener('statechange', portsChanged);
    portOptions();
    portsVisible.value = true;
    status.value = 'Choose the SQ-64 sequencer input and output';
  } catch (error) {
    status.value = error.message;
  }
}
async function openPorts() {
  try {
    const input = access.inputs.get(inputId.value),
      output = access.outputs.get(outputId.value);
    if (!input || !output) throw Error('Select both MIDI ports');
    await input.open();
    await output.open();
    closeSession();
    emulatorSelected = false;
    selectSession(new MidiSession(input, output));
    connectionState.value = 'MIDI ports connected';
    modeNote.value = '';
    status.value = 'Connected. Use normal mode for backup, update mode for firmware.';
  } catch (error) {
    status.value = error.message;
  }
}
function connectDemo() {
  closeSession();
  emulatorSelected = false;
  selectSession(new DemoSession());
  modeNote.value = 'Synthetic protocol demonstration. No physical device is connected.';
  connectionState.value = 'Protocol demonstration';
  status.value = 'Simulation ready';
}
async function connectEmulator() {
  workbenchOpen.value = true;
  if (!emulator.loaded) {
    status.value = 'Load your firmware in the browser workbench below, then connect to it here.';
    await nextTick();
    workbench.value.scrollIntoView({ behavior: 'smooth' });
    return;
  }
  closeSession();
  emulatorSelected = true;
  selectSession(new MidiSession(emulator.input, emulator.output, { timeout: 30000 }));
  connectionState.value = 'Browser emulator connected';
  modeNote.value = 'ARM firmware runs in this browser. The updater is connected only to this emulator.';
  status.value = 'Emulator connected. Run firmware in normal mode for backups or update mode for installation.';
}
function emulatorFault(event) {
  if (emulator.terminated) safetyStop.value = emulator.terminated;
  if (emulatorSelected) {
    closeSession();
    status.value = 'Emulator stopped: ' + event.detail;
  }
}
emulator.addEventListener('fault', emulatorFault);
async function loadFirmware(event) {
  const revision = ++fileRevision;
  firmware.value = null;
  fileInfo.value = 'No firmware selected';
  try {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size !== 0x38100) throw Error('Expected a 229,632-byte VSB system file');
    const parsed = parseVsb(await file.arrayBuffer()),
      digest = await sha256(parsed.data);
    if (revision !== fileRevision) return;
    firmware.value = parsed;
    fileInfo.value = `${file.name} · version ${parsed.version[0]}.${String(parsed.version[1]).padStart(2, '0')} · four checksums valid\nSHA-256 ${digest}`;
  } catch (error) {
    if (revision === fileRevision) fileInfo.value = error.message;
  }
}
function startBackup() {
  return operation(async () => {
    status.value = 'Reading device contents…';
    const result = await createBackup(session, {
      scope: scope.value,
      channel: channel.value,
      onProgress: (p) => {
        status.value = `Reading ${p.kind}${p.index === null ? '' : ` ${p.index + 1}`} · ${p.captured} items`;
      },
    });
    save(
      result,
      `sq64-${session instanceof DemoSession ? 'demo-' : ''}backup-${new Date().toISOString().slice(0, 10)}.json`,
    );
    progress.value = 100;
    status.value = 'Backup saved';
    log(`${result.records.length} records validated. Firmware and factory calibration are excluded.`);
  });
}
function startUpdate() {
  if (!firmware.value || !ready.value) return;
  return operation(async () => {
    let began = false;
    try {
      await updateFirmware(session, firmware.value, {
        allowOlder: older.value,
        onProgress: (p) => {
          if (p.phase === 'begin') began = true;
          status.value =
            p.phase === 'writing'
              ? 'Device is writing…'
              : p.phase === 'begin'
                ? 'Starting update…'
                : p.phase === 'await-device-completion'
                  ? 'Waiting for completion on the device'
                  : 'Transmitting firmware…';
          if (p.total) {
            progress.value = Math.round((100 * p.done) / p.total);
            percent.value = `${progress.value}%`;
          }
        },
      });
      awaitingCompletion.value = true;
      log('All packets acknowledged. Confirm completion on the SQ-64 display before restarting.');
    } catch (error) {
      if (began) log('Update may have begun. Keep power connected and check the device. Do not blindly retry.');
      throw error;
    }
  });
}
function confirmCompletion() {
  awaitingCompletion.value = false;
  closeSession();
  status.value = 'Device completion confirmed by you. Restart and reconnect to verify the new version.';
}
async function loadBackup(event) {
  const revision = ++backupRevision;
  archive.value = null;
  backupInfo.value = 'No backup selected';
  try {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > 40 * 1024 * 1024) throw Error('Backup exceeds the 40 MiB limit');
    const parsed = await validateBackup(JSON.parse(await file.text()));
    if (revision !== backupRevision) return;
    archive.value = parsed;
    backupInfo.value = `${file.name} · ${parsed.scope} · ${parsed.records.length} verified records`;
  } catch (error) {
    if (revision === backupRevision) backupInfo.value = error.message;
  }
}
function startRestore() {
  if (!archive.value || !restoreReady.value) return;
  return operation(async () => {
    status.value = 'Restoring included data…';
    const result = await restoreBackup(session, archive.value, {
      channel: channel.value,
      onProgress: (p) => {
        status.value = `Restored ${p.restored} records · ${p.kind}`;
      },
    });
    progress.value = 100;
    status.value = 'Restore acknowledged by device';
    log(
      `${result.restored} records written. Verify your projects, then use the power button and wait for shutdown before restarting. An abrupt reset can lose the restored catalog and current workspace. Persistence has not been checked for this restore.`,
    );
  });
}
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', beforeUnload);
  access?.removeEventListener('statechange', portsChanged);
  emulator.removeEventListener('fault', emulatorFault);
  emulator.removeEventListener('state', emulatorState);
  closeSession();
  emulator.close();
  if (window.sq64Emulator === emulator) delete window.sq64Emulator;
});
</script>

<template>
  <header>
    <a class="brand" href="./"
      ><img src="../assets/aleph-void.png" alt="" /><span>Aleph Void <small>SQ-64 / DEVICE TOOLS</small></span></a
    ><span class="local"><i></i> Files stay on this computer</span>
  </header>
  <main>
    <section v-if="safetyStop" id="emulator-safety-stop" class="safety-stop" role="alert" aria-live="assertive">
      <h2>Do not flash this firmware to a real device.</h2>
      <p>{{ safetyStop.message }}</p>
      <p>Loaded file SHA-256: {{ safetyStop.imageSha256 }}</p>
    </section>
    <div class="intro">
      <div>
        <p class="eyebrow">YOUR SEQUENCER. YOUR FIRMWARE.</p>
        <h1>Keep your ideas.<br />Make room for what’s next.</h1>
        <p>Back up your SQ-64 and install firmware directly from your browser.</p>
      </div>
      <div class="grid-art" aria-hidden="true"></div>
    </div>
    <div class="workspace">
      <aside class="connection">
        <p class="eyebrow">01 / CONNECTION</p>
        <h2>Your SQ-64</h2>
        <p id="connection-state" role="status">{{ connectionState }}</p>
        <button id="connect" class="primary" :disabled="locked" @click="enableMidi">Enable MIDI access</button>
        <div id="ports" :hidden="!portsVisible">
          <label
            >MIDI input<select id="input" v-model="inputId" :disabled="locked">
              <option v-for="port in inputs" :key="port.id" :value="port.id">{{ port.label }}</option>
            </select></label
          ><label
            >MIDI output<select id="output" v-model="outputId" :disabled="locked">
              <option v-for="port in outputs" :key="port.id" :value="port.id">{{ port.label }}</option>
            </select></label
          ><button id="open" :disabled="locked" @click="openPorts">Connect selected ports</button>
        </div>
        <label
          >Global MIDI channel<select id="channel" v-model.number="channel" :disabled="locked">
            <option v-for="number in 16" :key="number" :value="number - 1">{{ number }}</option>
          </select></label
        ><button id="emulated" class="primary" :disabled="locked || !!safetyStop" @click="connectEmulator">
          Connect browser emulator</button
        ><button id="demo" class="quiet" :disabled="locked" @click="connectDemo">Try a simulated device</button>
        <p class="hint">
          Use a desktop browser with Web MIDI support. Connect by USB. Select the SQ-64’s sequencer ports.
        </p>
        <div id="mode-note" class="notice" :hidden="!modeNote">{{ modeNote }}</div>
      </aside>
      <section class="tool">
        <nav aria-label="Device tools">
          <button data-tab="backup" :aria-pressed="tab === 'backup'" @click="tab = 'backup'">Back up</button
          ><button data-tab="update" :aria-pressed="tab === 'update'" @click="tab = 'update'">Update firmware</button
          ><button data-tab="restore" :aria-pressed="tab === 'restore'" @click="tab = 'restore'">Restore</button>
        </nav>
        <div id="backup" class="tab" :hidden="tab !== 'backup'">
          <p class="eyebrow">02 / PRESERVE YOUR WORK</p>
          <h2>A copy of your ideas.</h2>
          <p>
            Save projects, patterns, controls, global settings, and user scales to a file on this computer. Use normal
            operation mode and stop playback first.
          </p>
          <label
            >What to include<select id="scope" v-model="scope" :disabled="locked">
              <option value="all">All saved projects, current project, and settings</option>
              <option value="current">Current project and settings</option>
              <option value="settings">Settings and user scales</option>
            </select></label
          >
          <p class="hint">
            The backup excludes firmware, factory calibration, and undocumented storage. Keep the device idle until
            capture finishes.
          </p>
          <button id="backup-start" class="primary" :disabled="locked || !connected" @click="startBackup">
            Download backup
          </button>
        </div>
        <div id="update" class="tab" :hidden="tab !== 'update'">
          <p class="eyebrow">02 / INSTALL FIRMWARE</p>
          <h2>A new chapter.</h2>
          <p>
            Choose your firmware file, then start the SQ-64 in update mode by holding GLOBAL + PATTERN while powering
            on.
          </p>
          <label class="file-box"
            >Select a .VSB firmware file<input
              id="firmware"
              type="file"
              accept=".vsb,.VSB"
              :disabled="locked"
              @change="loadFirmware"
          /></label>
          <p class="hint">
            <a
              id="official-firmware-zip"
              href="https://cdn.korg.com/jp/support/download/files/765e1fc1c8b5e0fe446fefb7199dd6bf.zip"
              target="_blank"
              rel="noopener noreferrer"
              >Download Korg 2.03 firmware ZIP</a
            >
            · Extract the .VSB file before selecting it.
          </p>
          <div id="file-info" class="file-info">{{ fileInfo }}</div>
          <label class="check"
            ><input id="older" type="checkbox" v-model="older" :disabled="locked" />Allow reinstalling the same version
            or a downgrade</label
          ><label class="check"
            ><input id="ready" type="checkbox" v-model="ready" :disabled="locked" />I have saved my work and will keep
            USB and power connected until the device confirms completion.</label
          >
          <p class="hint">
            Checksums detect damage; they do not prove that custom firmware works. Interrupted flash programming can
            prevent USB recovery.
          </p>
          <button
            id="update-start"
            class="primary"
            :disabled="locked || !connected || !firmware || !ready"
            @click="startUpdate"
          >
            Install selected firmware
          </button>
          <div id="completion" class="notice" :hidden="!awaitingCompletion">
            <strong>Transmission finished.</strong> Keep power connected. Wait for completion on the SQ-64 display
            before restarting.<button id="confirm-completion" @click="confirmCompletion">
              The device confirms completion
            </button>
          </div>
        </div>
        <div id="restore" class="tab" :hidden="tab !== 'restore'">
          <p class="eyebrow">02 / RESTORE YOUR WORK</p>
          <h2>Pick up where you left off.</h2>
          <p>
            Restore a backup created here. Included projects and settings overwrite matching device slots. Slots
            recorded as empty are left unchanged.
          </p>
          <label class="file-box"
            >Select a backup file<input
              id="backup-file"
              type="file"
              accept=".json"
              :disabled="locked"
              @change="loadBackup"
          /></label>
          <div id="backup-info" class="file-info">{{ backupInfo }}</div>
          <label class="check"
            ><input id="restore-ready" type="checkbox" v-model="restoreReady" :disabled="locked" />I have backed up the
            device’s current contents and want to overwrite the included slots.</label
          ><button
            id="restore-start"
            class="primary"
            :disabled="locked || !connected || !archive || !restoreReady"
            @click="startRestore"
          >
            Restore included data
          </button>
          <p class="hint">
            Use normal operation mode. After restoring, inspect projects and save/restart as appropriate. Device
            acknowledgements alone do not verify persistence.
          </p>
        </div>
        <div id="activity" aria-live="polite">
          <div class="activity-heading">
            <span id="status">{{ status }}</span
            ><span id="percent">{{ percent }}</span>
          </div>
          <progress id="progress" max="100" :value="progress"></progress>
          <pre id="log" ref="logElement">{{ logText }}</pre>
        </div>
      </section>
    </div>
    <details id="browser-workbench" ref="workbench" :open="workbenchOpen" @toggle="workbenchOpen = $event.target.open">
      <summary>Browser emulator · run your firmware here</summary>
      <iframe
        id="emulator-frame"
        title="SQ-64 browser firmware emulator"
        allow="fullscreen"
        allowfullscreen
        src="emulator/index.html"
      ></iframe>
    </details>
    <footer>
      <span>Aleph Void · Independent tools. Not affiliated with Korg. · v{{ version }}</span
      ><span>No account. No uploads. No vendor firmware bundled.</span
      ><span
        ><a href="LICENSE" target="_blank" rel="noopener">GPLv2 license</a> ·
        <a href="https://github.com/aleph-void/Korg-SQ-64-Emulator" target="_blank" rel="noopener noreferrer"
          >Source code</a
        >
        · <a href="vendor/unicorn-arm-source.tar.gz">Unicorn source</a></span
      >
    </footer>
  </main>
</template>
