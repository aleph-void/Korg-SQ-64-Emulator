import {frame, parseFrame, unpack, hex, unhex, sha256} from './protocol.js';

export const normalPrefix = channel => {
  if (!Number.isInteger(channel) || channel < 0 || channel > 15) throw Error('Invalid MIDI channel');
  return [0xf0, 0x42, 0x30 + channel, 0, 1, 0x60];
};
const TYPES = {
  global: [0x0e, 0x50, 512, null, 'GLOB'],
  currentControl: [0x14, 0x44, 2048, null, 'CTRL'],
  control: [0x15, 0x45, 2048, 16, 'CTRL'],
  scale: [0x17, 0x47, 36, 6, null],
  currentProject: [0x11, 0x41, 512, null, 'PROJ'],
  project: [0x1d, 0x4d, 512, 64, 'PROJ'],
  melody: [0x18, 0x48, 3104, 48, null],
  rhythm: [0x19, 0x49, 6176, 16, null],
};
function descriptor(kind, index) {
  const type = TYPES[kind];
  if (!type || (type[3] === null ? index !== null : !Number.isInteger(index) || index < 0 || index >= type[3])) throw Error('Invalid backup item identifier');
  return type;
}
export function decodeDump(data, kind, index, channel) {
  const [, reply, length, limit, tag] = descriptor(kind, index);
  const {command, body} = parseFrame(data, normalPrefix(channel));
  if (command === 0x30 && !body.length) return null;
  if (command !== reply) throw Error(`Unexpected ${kind} response: 0x${command.toString(16)}`);
  if (limit !== null && body[0] !== index) throw Error('Reply slot does not match request');
  const raw = unpack(body.slice(limit === null ? 0 : 1), length);
  if (tag && new TextDecoder().decode(raw.slice(0, 4)) !== tag) throw Error(`Invalid ${kind} data tag`);
  return raw;
}
export function presentPatterns(header) {
  if (header.length !== 512) throw Error('Invalid project header');
  const patterns = [];
  for (let track = 0; track < 4; track++) for (let pattern = 0; pattern < 16; pattern++) {
    if (header[40 + track * 2 + (pattern >> 3)] & (1 << (pattern & 7))) patterns.push({kind: track < 3 ? 'melody' : 'rhythm', index: track < 3 ? track * 16 + pattern : pattern});
  }
  return patterns;
}
function channelExchange(session, channel, command, body = []) {
  const prefix = normalPrefix(channel);
  return session.exchange(frame(command, body, prefix), {matches: data => prefix.every((b, i) => data[i] === b)});
}
async function finalize(session, channel) {
  const {command, body} = parseFrame(await channelExchange(session, channel, 0x70), normalPrefix(channel));
  if (command !== 0x23 || body.length) throw Error('Project transfer did not finalize');
}
export async function createBackup(session, {channel = 0, scope = 'all', onProgress = () => {}, now = () => new Date().toISOString()} = {}) {
  normalPrefix(channel);
  if (!['settings', 'current', 'all'].includes(scope)) throw Error('Unknown backup scope');
  const records = [];
  async function capture(kind, index = null, project = null, required = false) {
    const [request, , , limit] = descriptor(kind, index);
    const reply = await channelExchange(session, channel, request, limit === null ? [] : [index]);
    const raw = decodeDump(reply, kind, index, channel);
    if (required && !raw) throw Error(`Missing required ${kind} data`);
    const data = raw ? hex(reply) : null;
    records.push({kind, index, project, data, sha256: data ? await sha256(reply) : null});
    onProgress({kind, index, project, captured: records.length});
    return raw;
  }
  async function project(kind, index) {
    const header = await capture(kind, index, index, kind === 'currentProject');
    if (!header) return;
    try {
      for (const pattern of presentPatterns(header)) await capture(pattern.kind, pattern.index, index, true);
    } finally { if (!session.closed) await finalize(session, channel); }
  }
  await capture('global', null, null, true);
  await capture('currentControl', null, null, true);
  for (let i = 0; i < 6; i++) await capture('scale', i);
  if (scope === 'all') for (let i = 0; i < 16; i++) await capture('control', i);
  if (scope !== 'settings') await project('currentProject', null);
  if (scope === 'all') for (let i = 0; i < 64; i++) await project('project', i);
  const archive = {format: 'sq64-backup', version: 1, channel, scope, createdAt: now(), complete: true,
    excludes: ['firmware', 'factory-calibration', 'undocumented-device-storage'], records};
  await validateBackup(archive);
  return archive;
}
export async function validateBackup(archive) {
  if (!archive || archive.format !== 'sq64-backup' || archive.version !== 1 || archive.complete !== true || !['settings', 'current', 'all'].includes(archive.scope) || !Array.isArray(archive.records) || archive.records.length > 4250) throw Error('Invalid or incomplete backup archive');
  normalPrefix(archive.channel);
  const records = new Map(), decoded = new Map();
  const key = r => `${r.kind}/${r.index}/${r.project}`;
  for (const record of archive.records) {
    descriptor(record.kind, record.index);
    const isPattern = ['melody', 'rhythm'].includes(record.kind);
    if (isPattern ? !(record.project === null || Number.isInteger(record.project) && record.project >= 0 && record.project < 64) : record.project !== (record.kind === 'project' ? record.index : null)) throw Error('Invalid project association');
    if (records.has(key(record))) throw Error('Duplicate backup record');
    records.set(key(record), record);
    if (record.data === null) {
      if (record.sha256 !== null || ['global', 'currentControl', 'currentProject', 'melody', 'rhythm'].includes(record.kind)) throw Error('Required backup data is missing');
      decoded.set(key(record), null); continue;
    }
    if (typeof record.data !== 'string' || record.data.length > 15000) throw Error('Invalid backup record length');
    const data = unhex(record.data);
    if (await sha256(data) !== record.sha256) throw Error('Backup digest mismatch');
    const raw = decodeDump(data, record.kind, record.index, archive.channel);
    if (!raw) throw Error('Empty slot must be represented explicitly');
    decoded.set(key(record), raw);
  }
  const expected = new Set();
  function requireItem(kind, index = null, project = null) {
    const k = key({kind, index, project}); expected.add(k);
    if (!records.has(k)) throw Error(`Backup is missing ${k}`);
    return decoded.get(k);
  }
  requireItem('global'); requireItem('currentControl');
  for (let i = 0; i < 6; i++) requireItem('scale', i);
  if (archive.scope === 'all') for (let i = 0; i < 16; i++) requireItem('control', i);
  const projects = archive.scope === 'all' ? [null, ...Array.from({length: 64}, (_, i) => i)] : archive.scope === 'current' ? [null] : [];
  for (const project of projects) {
    const header = requireItem(project === null ? 'currentProject' : 'project', project, project);
    if (header) for (const item of presentPatterns(header)) requireItem(item.kind, item.index, project);
  }
  if (expected.size !== records.size) throw Error('Backup contains unreferenced or out-of-scope records');
  return archive;
}
export async function restoreBackup(session, archive, {channel = 0, onProgress = () => {}} = {}) {
  // Validate every record before the first device write. Empty slots are left alone.
  await validateBackup(archive); normalPrefix(channel);
  let restored = 0;
  const send = async record => {
    if (!record.data) return;
    const data = unhex(record.data); data[2] = 0x30 + channel;
    const prefix = normalPrefix(channel);
    const reply = await session.exchange(data, {matches: reply => record.kind === 'global'
      ? reply.length >= 8 && reply[0] === 0xf0 && reply[1] === 0x42 && reply[2] >= 0x30 && reply[2] <= 0x3f && reply[3] === 0 && reply[4] === 1 && reply[5] === 0x60
      : prefix.every((b, i) => reply[i] === b)});
    const {command, body} = parseFrame(reply, record.kind === 'global' ? normalPrefix(reply[2] - 0x30) : prefix);
    if (command !== 0x23 || body.length) throw Error(`Restore rejected for ${record.kind}: 0x${command.toString(16)}`);
    onProgress({restored: ++restored, kind: record.kind});
  };
  // Global settings can change the device's MIDI channel; restore them last.
  for (const kind of ['control', 'scale', 'currentControl']) for (const r of archive.records.filter(r => r.kind === kind)) await send(r);
  for (const header of archive.records.filter(r => ['project', 'currentProject'].includes(r.kind))) {
    if (!header.data) continue;
    await send(header);
    try {
      for (const r of archive.records.filter(r => ['melody', 'rhythm'].includes(r.kind) && r.project === header.index)) await send(r);
      await finalize(session, channel);
    } catch (error) { session.close(error); throw error; }
  }
  await send(archive.records.find(r => r.kind === 'global'));
  return {restored, verifiedByReadback: false};
}
