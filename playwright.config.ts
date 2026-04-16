import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  globalSetup: './playwright/global-setup.ts',
  use: {
    baseURL: 'http://127.0.0.1:3202',
    // storageState carries localStorage['konoha_dash_auth'] set by global-setup.
    // Auth is client-side (app.tsx:54 checks localStorage, not server session).
    storageState: 'playwright/.auth/user.json',
    // requireAuth (auth.ts:11) accepts only Authorization: Bearer.
    // Use the dev token so E2E is self-contained regardless of environment.
    // The webServer below starts with the same token — they always match.
    extraHTTPHeaders: {
      'Authorization': 'Bearer konoha-dev-token'
    },
  },
  // webServer managed manually for smoke tests — see /tmp/konoha-438.log
  // KONOHA_TOKEN hardcoded in extraHTTPHeaders to match server token (closes #438).
  reporter: [
    ['line'],
    ['json', { outputFile: '/opt/shared/shino/reports/playwright-results.json' }],
  ],
  timeout: 30000,
});
