import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
test('Pages export contains only deployable web files and refuses to overwrite a branch', async () => {
  const out = await mkdtemp(join(tmpdir(), 'sq64-pages-'));
  try {
    execFileSync(process.execPath, ['tools/build.js', '--out', out]);
    const entries = await readdir(out);
    for (const excluded of ['sq64_emulator', 'tests', 'tools', 'node_modules', 'package.json', 'recomp']) assert.equal(entries.includes(excluded), false);
    for (const needed of ['index.html', 'emulator', 'vendor', 'examples', 'CNAME', '.nojekyll']) assert.equal(entries.includes(needed), true);
    assert.equal((await readFile(join(out, 'CNAME'), 'utf8')).trim(), 'sq64.alephvoid.com');
    assert.throws(() => execFileSync(process.execPath, ['tools/build.js', '--out', out], {stdio: 'pipe'}), /Command failed/);
  } finally { await rm(out, {recursive: true, force: true}); }
});
