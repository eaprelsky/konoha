import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  use: { baseURL: 'http://127.0.0.1:3199' },
  webServer: {
    command: 'KONOHA_PORT=3199 bun run src/server.ts',
    url: 'http://127.0.0.1:3199/ui/index.html',
    reuseExistingServer: false,
    timeout: 30000,
  },
  reporter: [
    ['line'],
    ['json', { outputFile: '/opt/shared/shino/reports/playwright-results.json' }],
  ],
  timeout: 30000,
});
