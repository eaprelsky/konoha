/**
 * Playwright global setup — injects localStorage auth state directly.
 * Runs before any test suite; the saved state is reused by all tests
 * via `use.storageState` in playwright.config.ts.
 *
 * Auth is client-side only (Login.tsx validates VALID_USER/VALID_PASS in-browser
 * and sets localStorage['konoha_dash_auth'] = '1'). No server session involved.
 * We set it directly to avoid dependency on form rendering or E2E_PASSWORD env var.
 */
import { chromium, type FullConfig } from '@playwright/test';
import { mkdirSync } from 'fs';
import path from 'path';

const AUTH_FILE = path.join(__dirname, '.auth/user.json');

async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use?.baseURL ?? 'http://127.0.0.1:3202';

  mkdirSync(path.join(__dirname, '.auth'), { recursive: true });
  mkdirSync('/opt/shared/shino/reports', { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  // Navigate to establish the origin so localStorage is scoped correctly.
  // The SPA will redirect to /ui/login — that's fine; we set localStorage before the next navigate.
  await page.goto(`${baseURL}/ui/`);
  await page.waitForLoadState('domcontentloaded');

  // Set auth flag directly — mirrors what Login.tsx does on successful login.
  // No E2E_PASSWORD needed; auth is purely client-side (app.tsx:54 checks localStorage).
  await page.evaluate(() => {
    localStorage.setItem('konoha_dash_auth', '1');
    localStorage.setItem('konoha_dash_user', 'eaprelsky');
  });

  await context.storageState({ path: AUTH_FILE });
  await browser.close();
}

export default globalSetup;
