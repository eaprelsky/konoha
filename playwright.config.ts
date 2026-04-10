import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  globalSetup: './playwright/global-setup.ts',
  use: {
    baseURL: 'http://127.0.0.1:3202',
    storageState: 'playwright/.auth/user.json',
    // requireAuth (auth.ts:11) only accepts Authorization: Bearer — no cookie-based auth.
    // extraHTTPHeaders injects the token into all requests (page + request fixture),
    // so individual specs don't need to repeat it.
    extraHTTPHeaders: {
      'Authorization': `Bearer ${process.env.KONOHA_TOKEN ?? 'konoha-dev-token'}`
    },
  },
  webServer: {
    // Port 3201 is reserved by konoha-dashboard (monitoring UI, pid 2178509).
    // Use 3202 and never reuse an existing server to avoid attaching to the wrong process (closes #435).
    command: 'KONOHA_PORT=3202 bun run src/server.ts',
    url: 'http://127.0.0.1:3202',
    reuseExistingServer: false,
    timeout: 30000,
  },
  reporter: [
    ['line'],
    ['json', { outputFile: '/opt/shared/shino/reports/playwright-results.json' }],
  ],
  timeout: 30000,
});
