import { defineConfig } from '@playwright/test';
import { base } from './playwright/base.config';

// CI config: always spins up a fresh server on port 3201 (avoids conflicts
// with the konoha-testbench service which owns 3200/3202 in staging).
// Usage: npx playwright test --config=playwright.config.ci.ts
export default defineConfig({
  ...base,
  use: {
    ...base.use,
    baseURL: 'http://127.0.0.1:3201',
  },
  webServer: {
    command: 'KONOHA_PORT=3201 KONOHA_TOKEN=konoha-dev-token bun run core/src/server.ts',
    url: 'http://127.0.0.1:3201/health',
    reuseExistingServer: false,
    timeout: 60000, // CI runners are faster, 60s is enough
  },
});
