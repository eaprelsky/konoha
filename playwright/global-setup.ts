/**
 * Playwright global setup — logs in once and saves auth state (storageState).
 * Runs before any test suite; the saved cookies/localStorage are reused
 * by all tests via `use.storageState` in playwright.config.ts.
 *
 * Credentials: test account used only for E2E runs.
 */
import { chromium, type FullConfig } from '@playwright/test';
import path from 'path';

const AUTH_FILE = path.join(__dirname, '.auth/user.json');

async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use?.baseURL ?? 'http://127.0.0.1:3202';

  const browser = await chromium.launch();
  const page = await browser.newPage();

  // SPA: navigate to /ui/login (React handles routing)
  await page.goto(`${baseURL}/ui/login`);
  await page.waitForLoadState('domcontentloaded');

  const username = process.env.E2E_USERNAME ?? 'eaprelsky';
  const password = process.env.E2E_PASSWORD;
  if (!password) throw new Error('E2E_PASSWORD env variable is required');

  await page.locator('input[autocomplete="username"], input[type="text"]').first().fill(username);
  await page.locator('input[type="password"]').first().fill(password);
  await page.locator('button[type="submit"]').click();

  // Wait for redirect away from login
  await page.waitForURL(url => !url.pathname.includes('/login'), { timeout: 15_000 });

  await page.context().storageState({ path: AUTH_FILE });
  await browser.close();
}

export default globalSetup;
