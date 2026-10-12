// Export the same templates used by the dropdown; no separate action definitions.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { SCRIPT_EXAMPLES } from '../web/emulator/script-examples.js';
import { BUG_SCRIPT_EXAMPLES } from '../web/emulator/bug-script-examples.js';
import { validateScript } from '../web/emulator/scripts.js';
const check = process.argv.includes('--check');
if (process.argv.slice(2).some(arg => arg !== '--check')) throw Error('Usage: node tools/export_bug_script_examples.mjs [--check]');
const directory = new URL('../web/examples/scripts/', import.meta.url);
if (!check) await mkdir(directory, { recursive: true });
for (const { id } of BUG_SCRIPT_EXAMPLES) {
  const script = validateScript(SCRIPT_EXAMPLES.find(example => example.id === id).script);
  const target = new URL(`${id}.json`, directory), text = JSON.stringify(script, null, 2) + '\n';
  if (check) {
    if (await readFile(target, 'utf8') !== text) throw Error(`Stale example: ${fileURLToPath(target)}`);
  } else await writeFile(target, text);
}
