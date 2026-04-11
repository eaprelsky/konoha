import { defineConfig } from '@playwright/test';
import { base } from './playwright/base.config';

// Reuse config: attaches to an already-running server on port 3202.
// Useful for local development to avoid restart overhead.
export default defineConfig({
  ...base,
  webServer: {
    ...base.webServer!,
    reuseExistingServer: true,
  },
});
