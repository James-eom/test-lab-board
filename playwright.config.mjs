import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testMatch: '**/*.spec.mjs', workers: 1, timeout: 60000,
  use: { baseURL: 'http://127.0.0.1:4358', headless: true, timezoneId: 'Asia/Seoul' },
  webServer: { command: 'node server.mjs', url: 'http://127.0.0.1:4358/api/status', reuseExistingServer: false, env: { PORT: '4358', DB_PATH: `test-results/ui-${Date.now()}.sqlite` } },
});
