import { defineConfig } from '@playwright/test';
import { base } from './playwright/base.config';

// Smoke config: fast subset of tests tagged *smoke* or *-smoke.spec.ts*.
// Reuses an existing server to avoid startup overhead on quick smoke runs.
export default defineConfig({
  ...base,
  // Only run files matching the smoke pattern (e.g. tsunade-smoke.spec.ts)
  testMatch: ['**/*smoke*.spec.ts', '**/*smoke*.spec.js'],
  webServer: {
    ...base.webServer!,
    reuseExistingServer: true,
  },
});
