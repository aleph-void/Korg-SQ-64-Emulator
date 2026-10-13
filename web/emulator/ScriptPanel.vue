<script setup>
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import { ENCODERS } from './panel.js';
import { SCRIPT_FORMAT, SCRIPT_CONTROLS, MAX_SCRIPT_BYTES, parseScript, validateScript } from './scripts.js';
import { listScripts, saveScript, deleteScript } from './script-store.js';
import { save } from '../src/download.js';
import { SCRIPT_EXAMPLES } from './script-examples.js';

const props = defineProps({ state: { type: Object, required: true }, play: { type: Function, required: true }, loading: Boolean });
const name = ref('My UI script'), actions = ref('[]'), selected = ref(''), library = shallowRef([]);
const message = ref(''), storageMessage = ref(''), busy = ref(false), playing = ref(false), progress = ref(0);
const actionType = ref('press'), control = ref('play'), encoder = ref('tempo'), mode = ref('normal');
const duration = ref(100), delta = ref(1), down = ref(true), midi = ref('90 3c 64');
const allowOlder = ref(false);
const exampleId = ref('');
const example = computed(() => SCRIPT_EXAMPLES.find(item => item.id === exampleId.value));
let controller;
const editingDisabled = computed(() => busy.value || playing.value);
const runDisabled = computed(() => editingDisabled.value || !props.state.loaded || props.state.locked || props.state.scripting ||
  props.state.terminated || props.state.updating || props.state.report?.error || props.state.report?.debug?.enabled || props.loading);
function draft() {
  let parsed;
  try { parsed = JSON.parse(actions.value); } catch { throw Error('Actions must be a valid JSON array'); }
  return validateScript({ format: SCRIPT_FORMAT, version: 1, name: name.value, actions: parsed });
}
function open(script, id = '') {
  const valid = validateScript(script);
  name.value = valid.name;
  actions.value = JSON.stringify(valid.actions, null, 2);
  selected.value = id;
  progress.value = 0;
}
function newScript() {
  open({ format: SCRIPT_FORMAT, version: 1, name: 'My UI script', actions: [] });
  message.value = 'New script. Add actions below.';
}
function loadExample() {
  if (!example.value) return;
  open(example.value.script);
  message.value = `Loaded example: ${example.value.script.name}. Edit it or choose Run script.`;
}
async function refreshLibrary() {
  library.value = await listScripts();
  storageMessage.value = '';
}
async function refresh() {
  busy.value = true;
  try { await refreshLibrary(); }
  catch (error) { storageMessage.value = `Browser storage: ${error.message}`; }
  finally { busy.value = false; }
}
function selectScript(event) {
  const record = library.value.find(item => item.id === event.target.value);
  if (!record) { selected.value = ''; return; }
  try { open(record.script, record.id); message.value = `Opened ${record.script.name}`; }
  catch (error) { message.value = error.message; }
}
async function storeScript() {
  busy.value = true;
  try {
    const record = await saveScript(draft(), selected.value || undefined);
    selected.value = record.id;
    await refreshLibrary();
    message.value = `Saved ${record.script.name} in this browser`;
  } catch (error) { message.value = `Could not save: ${error.message}`; }
  finally { busy.value = false; }
}
async function removeScript() {
  if (!selected.value) return;
  busy.value = true;
  try {
    await deleteScript(selected.value);
    selected.value = '';
    await refreshLibrary();
    message.value = 'Deleted browser copy. The editor still contains your script.';
  } catch (error) { message.value = `Could not delete: ${error.message}`; }
  finally { busy.value = false; }
}
async function importScript(event) {
  const file = event.target.files[0];
  if (!file) return;
  busy.value = true;
  try {
    if (file.size > MAX_SCRIPT_BYTES) throw Error('Script exceeds 1 MiB');
    open(parseScript(await file.text()));
    message.value = `Imported ${file.name}. Choose Save in browser to keep it here.`;
  } catch (error) { message.value = `Could not import: ${error.message}`; }
  finally { event.target.value = ''; busy.value = false; }
}
function exportScript() {
  try {
    const script = draft();
    save(script, `${script.name.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '') || 'sq64-ui-script'}.json`);
    message.value = 'Script exported';
  } catch (error) { message.value = error.message; }
}
function addAction() {
  try {
    const script = draft();
    const action = { type: actionType.value };
    if (action.type === 'power-on') action.mode = mode.value;
    if (action.type === 'firmware-update') action.allowOlder = allowOlder.value;
    if (['wait', 'press'].includes(action.type)) action.ms = duration.value;
    if (['button', 'press'].includes(action.type)) action.control = control.value;
    if (action.type === 'button') action.down = down.value;
    if (action.type === 'encoder') { action.control = encoder.value; action.delta = delta.value; }
    if (action.type === 'midi') {
      if (!/^[0-9a-f]{2}(\s+[0-9a-f]{2})*$/i.test(midi.value.trim())) throw Error('Enter MIDI hexadecimal bytes separated by spaces');
      action.data = midi.value.trim().split(/\s+/).map(value => parseInt(value, 16));
    }
    script.actions.push(action);
    actions.value = JSON.stringify(validateScript(script).actions, null, 2);
    message.value = `Added action ${script.actions.length}`;
  } catch (error) { message.value = error.message; }
}
async function run() {
  if (runDisabled.value) return;
  try {
    const script = draft();
    controller = new AbortController();
    playing.value = true;
    progress.value = 0;
    message.value = 'Starting script…';
    const result = await props.play(script, event => {
      progress.value = event.total ? event.index / event.total * 100 : 100;
      if (event.action) message.value = `Action ${event.index + 1} of ${event.total}: ${event.label}`;
    }, controller.signal);
    message.value = result.report?.board.poweredOff ? 'Script complete · powered off' : 'Script complete · emulator keeps running';
  } catch (error) {
    message.value = controller?.signal.aborted ? 'Script stopped · remaining actions cancelled' : `Script failed: ${error.message}`;
  } finally { playing.value = false; controller = undefined; }
}
function stop() { controller?.abort(new DOMException('Script stopped', 'AbortError')); }
onMounted(() => {
  refresh();
  // The firmware repository list imports a loaded image's published UI scripts.
  window.addEventListener('sq64-scripts-changed', refresh);
});
onBeforeUnmount(() => {
  stop();
  window.removeEventListener('sq64-scripts-changed', refresh);
});
</script>

<template>
  <section id="ui-scripts" class="scripts">
    <h2>UI scripts</h2>
    <p>Build a sequence of panel actions, or edit its JSON. Wait and press durations use milliseconds of browser time.
      The emulator keeps running after the script unless you add Power off.</p>
    <div class="script-library">
      <label>Example scripts<select id="script-examples" v-model="exampleId" :disabled="editingDisabled">
        <option value="">Choose an example</option>
        <option v-for="item in SCRIPT_EXAMPLES" :key="item.id" :value="item.id">{{ item.script.name }}</option>
      </select></label>
      <button id="script-load-example" :disabled="editingDisabled || !example" @click="loadExample">Load example</button>
    </div>
    <p v-if="example" id="script-example-description" class="hint">{{ example.description }} Adjust waits for your firmware and computer.</p>
    <div class="script-library">
      <label>Saved scripts
        <select id="script-library" v-model="selected" :disabled="editingDisabled" @change="selectScript">
          <option value="">Unsaved script</option>
          <option v-for="record in library" :key="record.id" :value="record.id">{{ record.script.name }}</option>
        </select>
      </label>
      <button id="script-refresh" :disabled="editingDisabled" @click="refresh">Refresh library</button>
      <button id="script-new" :disabled="editingDisabled" @click="newScript">New script</button>
      <button id="script-save" :disabled="editingDisabled" @click="storeScript">Save in browser</button>
      <button id="script-delete" :disabled="editingDisabled || !selected" @click="removeScript">Delete saved script</button>
    </div>
    <p v-if="storageMessage" role="status">{{ storageMessage }}</p>
    <label>Script name<input id="script-name" v-model="name" maxlength="120" :disabled="editingDisabled" /></label>
    <form class="script-builder" @submit.prevent="addAction">
      <label>Action<select id="script-action-type" v-model="actionType" :disabled="editingDisabled">
        <option value="press">Press button / pad</option><option value="button">Hold / release button / pad</option>
        <option value="encoder">Turn encoder</option><option value="wait">Wait</option>
        <option value="power-on">Power on</option><option value="power-off">Power off</option><option value="midi">Send MIDI</option>
        <option value="firmware-update">Send update firmware</option>
      </select></label>
      <label v-if="['press', 'button'].includes(actionType)">Control<select id="script-control" v-model="control" :disabled="editingDisabled">
        <option v-for="item in SCRIPT_CONTROLS" :key="item" :value="item">{{ item }}</option>
      </select></label>
      <label v-if="actionType === 'button'">State<select id="script-down" v-model="down" :disabled="editingDisabled">
        <option :value="true">Hold</option><option :value="false">Release</option>
      </select></label>
      <label v-if="actionType === 'encoder'">Encoder<select id="script-encoder" v-model="encoder" :disabled="editingDisabled">
        <option v-for="item in ENCODERS" :key="item" :value="item">{{ item }}</option>
      </select></label>
      <label v-if="actionType === 'encoder'">Steps<input id="script-delta" type="number" min="-128" max="128" v-model.number="delta" :disabled="editingDisabled" /></label>
      <label v-if="['press', 'wait'].includes(actionType)">Duration (ms)<input id="script-duration" type="number" min="0" max="3600000" v-model.number="duration" :disabled="editingDisabled" /></label>
      <label v-if="actionType === 'power-on'">Startup mode<select id="script-mode" v-model="mode" :disabled="editingDisabled">
        <option value="normal">Normal</option><option value="version">Version</option><option value="update">Update</option>
      </select></label>
      <label v-if="actionType === 'midi'">Hexadecimal MIDI bytes<input id="script-midi" v-model="midi" :disabled="editingDisabled" /></label>
      <label v-if="actionType === 'firmware-update'"><input id="script-update-older" type="checkbox" v-model="allowOlder" :disabled="editingDisabled" />Allow reinstall / downgrade</label>
      <button id="script-add" type="submit" :disabled="editingDisabled">Append action</button>
    </form>
    <label>Actions (JSON array; edit, reorder, or remove entries here)
      <textarea id="script-actions" v-model="actions" rows="12" spellcheck="false" :disabled="editingDisabled"></textarea>
    </label>
    <div class="toolbar">
      <div>
        <button id="script-run" :disabled="runDisabled" @click="run">Run script</button>
        <button id="script-stop" :disabled="!playing" @click="stop">Stop script</button>
        <button id="script-export" :disabled="editingDisabled" @click="exportScript">Export script</button>
      </div>
      <label>Import script<input id="script-import" type="file" accept=".json,application/json" :disabled="editingDisabled" @change="importScript" /></label>
    </div>
    <progress aria-label="Script progress" max="100" :value="progress"></progress>
    <p id="script-status" role="status">{{ message || 'Ready to create or import a script' }}</p>
    <p class="hint">Scripts are stored in IndexedDB for this browser and site. Export a copy to move them elsewhere.
      Load firmware before playback and disable debugging. Add a startup wait for your firmware; first boot can take a minute or more.
      Power on resets immediately. Power off waits for firmware shutdown. Stop cancels remaining actions; held controls stay held,
      except an interrupted timed press is released. Send update firmware uses the separate update VSB selection above;
      its allowOlder setting is stored in the action. Stop also cancels an active transfer. Scripts contain no firmware or saved device data.</p>
  </section>
</template>
