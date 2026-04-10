import { defineConfig } from '@playwright/test';

// CI config: always spins up a fresh server instance (reuseExistingServer: false)
// to prevent state bleed between runs on shared CI runners.
// Usage: npx playwright test --config=playwright.config.ci.ts
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
    reuseExistingServer: false,
    timeout: 60000,
  },
  reporter: [
    ['line'],
    ['json', { outputFile: '/opt/shared/shino/reports/playwright-results.json' }],
  ],
  timeout: 30000,
});
