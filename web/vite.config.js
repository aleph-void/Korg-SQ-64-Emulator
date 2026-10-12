import {defineConfig} from 'vite';
import vue from '@vitejs/plugin-vue';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  root,
  base: './',
  publicDir: false,
  plugins: [vue()],
  define: {__APP_VERSION__: JSON.stringify(readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim())},
  server: {host: '127.0.0.1', port: 4173, strictPort: true},
  build: {
    rolldownOptions: {
      input: {tools: root + 'index.html', emulator: root + 'emulator/index.html'},
    },
  },
  worker: {format: 'es'},
});
