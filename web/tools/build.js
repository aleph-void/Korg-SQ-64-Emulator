import {cp, mkdir, rm, readdir, readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--out')) throw Error('Usage: npm run build -- [--out /path/to/empty/export-directory]');
const target = resolve(args[1] || resolve(root, 'dist'));
if (args.length) {
  try { if ((await readdir(target)).length) throw Error('Export directory must be empty; no deployment branch files will be overwritten'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
} else await rm(target, {recursive: true, force: true});
await mkdir(target, {recursive: true});
for (const path of ['index.html', 'style.css', 'src', 'assets', 'emulator', 'vendor', 'examples', 'CNAME', '_headers', '.nojekyll', 'LICENSE', 'NOTICE.txt']) await cp(resolve(root, path), resolve(target, path), {recursive: true});
const version = (await readFile(resolve(root, '../VERSION'), 'utf8')).trim();
const index = resolve(target, 'index.html');
await writeFile(index, (await readFile(index, 'utf8')).replaceAll('{{VERSION}}', version));
console.log(`Static web site exported to ${target} (version ${version})`);
