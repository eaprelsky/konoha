import { defineConfig } from '@playwright/test';
import { base } from './playwright/base.config';

// E2E config: attaches to an existing server on port 3201 (konoha-testbench).
// Used for running ./tests/e2e specs against a live staging instance.
const token = process.env.KONOHA_TOKEN ?? 'konoha-dev-token';
export default defineConfig({
  ...base,
  testDir: './tests/e2e',
  use: {
    ...base.use,
    baseURL: 'http://127.0.0.1:3201',
    extraHTTPHeaders: {
      'Authorization': `Bearer ${token}`,
    },
  },
  webServer: undefined, // Use existing server on 3201
});
