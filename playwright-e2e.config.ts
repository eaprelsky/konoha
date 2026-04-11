import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './playwright/global-setup.ts',
  use: {
    baseURL: 'http://127.0.0.1:3201',
    storageState: 'playwright/.auth/user.json',
    extraHTTPHeaders: {
      'Authorization': 'Bearer konoha-dev-token'
    },
  },
  webServer: undefined, // Use existing server on 3201
  reporter: [
    ['line'],
    ['json', { outputFile: '/opt/shared/shino/reports/playwright-results.json' }],
  ],
  timeout: 30000,
});
