import { defineConfig } from '@playwright/test';
import { base } from './playwright/base.config';

// Default config: fresh server per run to avoid state bleed (closes #435).
export default defineConfig({
  ...base,
  webServer: {
    ...base.webServer!,
    reuseExistingServer: false,
  },
});
