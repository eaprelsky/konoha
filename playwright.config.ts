import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  globalSetup: './playwright/global-setup.ts',
  use: {
    baseURL: 'http://127.0.0.1:3201',
    storageState: 'playwright/.auth/user.json',
  },
  webServer: {
    command: 'KONOHA_PORT=3201 bun run src/server.ts',
    url: 'http://127.0.0.1:3201',
    reuseExistingServer: true,
    timeout: 30000,
  },
  reporter: [
    ['line'],
    ['json', { outputFile: '/opt/shared/shino/reports/playwright-results.json' }],
  ],
  timeout: 30000,
});
