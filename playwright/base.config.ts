import type { PlaywrightTestConfig } from '@playwright/test';

/**
 * Shared base for all Playwright configs.
 * Each top-level config spreads this and overrides only what differs.
 * Centralises port, token, reporter, and server command in one place.
 */
export const base: PlaywrightTestConfig = {
  testDir: './e2e',
  globalSetup: './playwright/global-setup.ts',
  use: {
    baseURL: 'http://127.0.0.1:3202',
    storageState: 'playwright/.auth/user.json',
    // requireAuth (auth.ts) accepts only Authorization: Bearer.
    // Dev token matches the KONOHA_TOKEN passed to webServer — they always agree.
    extraHTTPHeaders: {
      'Authorization': 'Bearer konoha-dev-token',
    },
  },
  webServer: {
    // Port 3202: reserved for E2E (3201 = konoha-testbench, 3200 = konoha.service).
    // KONOHA_TOKEN hardcoded to dev token so server and extraHTTPHeaders always agree.
    command: 'KONOHA_PORT=3202 KONOHA_TOKEN=konoha-dev-token bun run core/src/server.ts',
    url: 'http://127.0.0.1:3202/health',
    reuseExistingServer: false,
    timeout: 90000, // bun startup can be slow in CI
  },
  reporter: [
    ['line'],
    ['json', { outputFile: '/opt/shared/shino/reports/playwright-results.json' }],
  ],
  timeout: 30000,
};
