import test from 'node:test';
import assert from 'node:assert/strict';
import {createBackup, validateBackup, restoreBackup, presentPatterns} from '../src/backup.js';
import {DemoSession} from '../src/demo.js';
import {sha256, unhex} from '../src/protocol.js';
test('all-content backup follows project sessions and includes every saved slot', async () => {
  const s = new DemoSession(), archive = await createBackup(s);
  assert.equal(archive.records.filter(r => r.kind === 'project').length, 64);
  assert.equal(archive.records.filter(r => r.kind === 'control').length, 16);
  assert.equal(archive.records.filter(r => r.kind === 'melody').length, 2);
  assert.equal(s.project, null); assert.equal(s.frames.filter(f => f[6] === 0x70).length, 2);
  assert.equal((await validateBackup(JSON.parse(JSON.stringify(archive)))).complete, true);
});
test('presence bits address every track and pattern without aliasing', () => {
  const header = new Uint8Array(512); header.fill(255, 40, 48);
  const patterns = presentPatterns(header);
  assert.equal(patterns.length, 64); assert.equal(new Set(patterns.map(p => `${p.kind}/${p.index}`)).size, 64);
});
test('damaged, missing, duplicate and extraneous backup records are rejected', async () => {
  const original = await createBackup(new DemoSession(), {scope: 'current'});
  for (const change of [a => { a.complete = false; }, a => a.records.pop(), a => a.records.push(a.records[0]), a => { a.records[0].sha256 = 'bad'; }, a => { a.records[0].data = null; }]) {
    const a = structuredClone(original); change(a); await assert.rejects(validateBackup(a));
  }
});
test('restore validates all data before writes and does not send injected commands', async () => {
  const a = await createBackup(new DemoSession(), {scope: 'settings'});
  const data = unhex(a.records[0].data); data[6] = 0x4e;
  a.records[0].data = Buffer.from(data).toString('hex'); a.records[0].sha256 = await sha256(data);
  const target = new DemoSession(); await assert.rejects(restoreBackup(target, a)); assert.equal(target.frames.length, 0);
});
test('restore sequences project data and global settings last, preserving empty slots', async () => {
  const a = await createBackup(new DemoSession()), target = new DemoSession();
  const result = await restoreBackup(target, a, {channel: 5});
  assert.equal(target.frames.at(-1)[6], 0x50); assert.ok(target.frames.every(f => f[2] === 0x35));
  assert.ok(!target.frames.some(f => [0x4e, 0x4f].includes(f[6])));
  assert.equal(result.verifiedByReadback, false);
});
test('pattern failure still finalizes the active project and produces no archive', async () => {
  const s = new DemoSession(), exchange = s.exchange.bind(s);
  s.exchange = async data => { if (data[6] === 0x18) throw Error('simulated read failure'); return exchange(data); };
  await assert.rejects(createBackup(s, {scope: 'current'}), /read failure/);
  assert.equal(s.frames.at(-1)[6], 0x70);
});
