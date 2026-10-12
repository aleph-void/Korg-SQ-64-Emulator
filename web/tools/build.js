import {cp, mkdir, rm, readdir, readFile, writeFile} from 'node:fs/promises';
import {relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {build} from 'vite';
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--out')) throw Error('Usage: npm run build -- [--out /path/to/empty/export-directory]');
const target = resolve(args[1] || resolve(root, 'dist'));
if (args.length) {
  try { if ((await readdir(target)).length) throw Error('Export directory must be empty; no deployment branch files will be overwritten'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
} else await rm(target, {recursive: true, force: true});
await mkdir(target, {recursive: true});
await build({configFile: resolve(root, 'vite.config.js'), build: {outDir: target, emptyOutDir: false}});
for (const path of ['assets', 'vendor', 'examples', 'CNAME', '_headers', '.nojekyll', 'LICENSE', 'NOTICE.txt', 'emulator/conformance/LICENSE', 'manifest.webmanifest', 'emulator/manifest.webmanifest']) {
  await cp(resolve(root, path), resolve(target, path), {recursive: true});
}
await cp(resolve(root, 'node_modules/vue/LICENSE'), resolve(target, 'vendor/vue-LICENSE.txt'));
const version = (await readFile(resolve(root, '../VERSION'), 'utf8')).trim();

// PWA export: link each page to its manifest (Vite would hash and relocate the
// manifest if the source HTML linked it, breaking its relative scope), then
// emit a service worker precaching every exported file so both pages install
// and run offline. The cache name hashes the precached bytes so any rebuild
// invalidates stale caches even without a version bump.
for (const page of ['index.html', 'emulator/index.html']) {
  const html = await readFile(resolve(target, page), 'utf8');
  await writeFile(resolve(target, page), html.replace('</head>', '<link rel="manifest" href="manifest.webmanifest"></head>'));
}
// The vendored source tarball is a download offer, not part of the running
// app, so offline installs skip its 4 MB; the worker still fetches it online.
const excluded = new Set(['CNAME', '_headers', '.nojekyll', 'sw.js', 'vendor/unicorn-arm-source.tar.gz']);
const precache = (await readdir(target, {recursive: true, withFileTypes: true}))
  .filter(entry => entry.isFile())
  .map(entry => relative(target, resolve(entry.parentPath, entry.name)).split(sep).join('/'))
  .filter(path => !excluded.has(path))
  .sort()
  .map(path => path === 'index.html' ? './' : path.endsWith('/index.html') ? path.slice(0, -'index.html'.length) : path);
const digest = createHash('sha256');
for (const path of precache) digest.update(path).update(await readFile(resolve(target, path === './' ? 'index.html' : path.endsWith('/') ? path + 'index.html' : path)));
const template = await readFile(resolve(root, 'tools/sw.template.js'), 'utf8');
await writeFile(resolve(target, 'sw.js'), template
  .replace('__CACHE_NAME__', `sq64-${version}-${digest.digest('hex').slice(0, 8)}`)
  .replace('__PRECACHE__', JSON.stringify(precache)));
console.log(`Static web site exported to ${target} (version ${version}, ${precache.length} precached files)`);
