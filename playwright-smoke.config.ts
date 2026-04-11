import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  globalSetup: './playwright/global-setup.ts',
  use: {
    baseURL: 'http://127.0.0.1:3202',
    storageState: 'playwright/.auth/user.json',
    extraHTTPHeaders: {
      'Authorization': 'Bearer konoha-dev-token'
    },
  },
  webServer: {
    command: 'KONOHA_PORT=3202 KONOHA_TOKEN=konoha-dev-token bun run core/src/server.ts',
    url: 'http://127.0.0.1:3202/health',
    reuseExistingServer: true,
    timeout: 90000,
  },
  reporter: [
    ['line'],
    ['json', { outputFile: '/opt/shared/shino/reports/playwright-results.json' }],
  ],
  timeout: 30000,
});
