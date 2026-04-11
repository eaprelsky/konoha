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
  webServer: {
    // Port 3201 is reserved by konoha-dashboard service (monitoring UI) — see docs/ports.md.
    // Use 3202 and never reuse an existing server to avoid attaching to the wrong process (closes #435).
    // KONOHA_TOKEN hardcoded to dev token so server and extraHTTPHeaders always agree (closes #438).
    command: 'KONOHA_PORT=3202 KONOHA_TOKEN=konoha-dev-token bun run core/src/server.ts',
    url: 'http://127.0.0.1:3202',
    reuseExistingServer: false,
    timeout: 90000, // server startup timeout (not test timeout) — 90s needed for bun startup in CI
  },
  reporter: [
    ['line'],
    ['json', { outputFile: '/opt/shared/shino/reports/playwright-results.json' }],
  ],
  timeout: 30000,
});
