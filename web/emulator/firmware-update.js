import { parseVsb } from '../src/protocol.js';
import { MidiSession, sleep, updateFirmware } from '../src/session.js';

export const emulatorUpdateContext = device => ({
  prepare: (pkg, caps) => device.request('prepare-update', { bytes: pkg.data, caps }),
  cancel: () => device.request('cancel-update'),
});

// Send through the running firmware's MIDI updater, never replace the machine
// or copy the candidate into flash from the host.
export async function submitFirmware(device, bytes, { allowOlder = false, signal, scripted = false,
  onProgress = () => {}, timeout = 120000, responseTimeout = 30000,
  delay = sleep, now = () => performance.now() } = {}) {
  signal?.throwIfAborted();
  const pkg = parseVsb(bytes);
  if (device.locked || device.updating || (device.scripting && !scripted))
    throw Error('Wait for the current script, updater or backup operation to finish');
  let session;
  const check = snapshot => {
    signal?.throwIfAborted();
    if (snapshot.terminated) throw Error(snapshot.terminated.message);
    if (!snapshot.loaded) throw Error('Load the boot firmware first');
    if (snapshot.report?.error) throw Error(snapshot.report.error);
    if (snapshot.report?.debug?.enabled) throw Error('Disable debugging before sending update firmware');
    if (snapshot.report?.board.poweredOff || snapshot.mode !== 'update')
      throw Error('Start the emulator in Update mode before sending update firmware');
  };
  const fault = event => session?.close(Error(event.detail));
  device.setUpdating(true);
  device.addEventListener('fault', fault);
  try {
    let snapshot = await device.request('state');
    check(snapshot);
    if (!snapshot.running) { snapshot = await device.request('run'); check(snapshot); }
    onProgress({ phase: 'waiting-for-updater' });
    const start = now();
    while ((snapshot.transport === 'usb' && snapshot.report.board.usb.phase !== 'configured') ||
        device.input.state !== 'connected' || device.output.state !== 'connected') {
      if (now() - start >= timeout) throw Error('Timed out waiting for the emulator updater connection');
      await delay(25, signal);
      snapshot = await device.request('state');
      check(snapshot);
    }
    session = new MidiSession(device.input, device.output, { timeout: responseTimeout, updateContext: emulatorUpdateContext(device) });
    return await updateFirmware(session, pkg, { allowOlder, signal, onProgress, delay });
  } finally {
    session?.close();
    device.removeEventListener('fault', fault);
    device.setUpdating(false);
  }
}
