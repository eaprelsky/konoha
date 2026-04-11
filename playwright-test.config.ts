import { defineConfig } from '@playwright/test';
import { base } from './playwright/base.config';

// Test config: targets ./tests/e2e (separate from e2e/ — issue-specific specs).
// Uses the KONOHA_TOKEN env var when provided (CI), falls back to dev token.
const token = process.env.KONOHA_TOKEN ?? 'konoha-dev-token';
export default defineConfig({
  ...base,
  testDir: './tests/e2e',
  use: {
    ...base.use,
    extraHTTPHeaders: {
      'Authorization': `Bearer ${token}`,
    },
  },
  webServer: {
    command: `KONOHA_PORT=3202 KONOHA_TOKEN=${token} bun run core/src/server.ts`,
    url: 'http://127.0.0.1:3202/health',
    reuseExistingServer: false,
    timeout: 120000, // issue-specific tests may need more server warmup time
  },
});
