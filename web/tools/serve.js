import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve, extname, sep} from 'node:path';
const root = resolve(process.env.SITE_ROOT || 'dist'), port = Number(process.env.PORT || 4173);
const version = await readFile(resolve(root, '../VERSION'), 'utf8').then(v => v.trim(), () => 'dev');
const types = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json'};
http.createServer(async (req, res) => {
  try {
    // Serve the same export under /dist/ as well to exercise repository-path hosting.
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const path = resolve(root, '.' + (pathname.startsWith('/dist/') ? pathname.slice(5) : pathname));
    if (!path.startsWith(root + sep) && path !== root) throw Error('Invalid path');
    const file = req.url.split('?')[0].endsWith('/') ? resolve(path, 'index.html') : path;
    const data = extname(file) === '.html' ? (await readFile(file, 'utf8')).replaceAll('{{VERSION}}', version) : await readFile(file);
    res.writeHead(200, {'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'"}); res.end(data);
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}`));
