import {defineConfig} from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser', timeout: 30000, fullyParallel: true,
  use: {baseURL: 'http://127.0.0.1:4173', trace: 'retain-on-failure',
    launchOptions: process.env.CHROMIUM_PATH ? {executablePath: process.env.CHROMIUM_PATH} : {}},
  webServer: {command: 'node tools/build.js && node tools/serve.js', url: 'http://127.0.0.1:4173', reuseExistingServer: false},
});
