import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  use: {
    baseURL: 'http://127.0.0.1:3202',
    extraHTTPHeaders: {
      'Authorization': 'Bearer konoha-dev-token'
    },
  },
  webServer: {
    command: 'KONOHA_PORT=3202 KONOHA_TOKEN=konoha-dev-token bun run core/src/server.ts',
    url: 'http://127.0.0.1:3202',
    reuseExistingServer: false,
    timeout: 120000,
  },
  reporter: [
    ['line'],
    ['json', { outputFile: '/opt/shared/shino/reports/playwright-results.json' }],
  ],
  timeout: 30000,
});
