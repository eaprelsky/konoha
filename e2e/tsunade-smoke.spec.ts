/**
 * Tsunade smoke test — e2e via Playwright (issue #350).
 *
 * Verifies:
 *   1. Login → ProcessEditor navigation works
 *   2. Tsunade chat panel opens
 *   3. Message can be sent
 *   4. Response (or loading indicator) appears in the chat
 *
 * Depends on fix TB-1 (#348): session_id respected in /testbench/action.
 */

import { test, expect } from '@playwright/test';

const LOGIN_URL   = '/ui/login';
const EDITOR_URL  = '/ui/editor';
const USERNAME    = process.env.E2E_USERNAME ?? 'eaprelsky';
const PASSWORD    = (() => {
  const p = process.env.E2E_PASSWORD;
  if (!p) throw new Error('E2E_PASSWORD env variable is required');
  return p;
})();

test.describe('Tsunade chat panel smoke test', () => {

  // Helper: log in via the login form and land on the editor
  async function loginAndGoToEditor(page: import('@playwright/test').Page) {
    await page.goto(LOGIN_URL);
    await page.waitForLoadState('domcontentloaded');

    // Fill credentials
    await page.locator('input[autocomplete="username"], input[type="text"]').first().fill(USERNAME);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.locator('button[type="submit"]').click();

    // Wait for redirect away from login page
    await page.waitForURL(/\/ui\/?(?!login)/, { timeout: 10_000 });

    // Navigate directly to editor
    await page.goto(EDITOR_URL);
    await page.waitForLoadState('domcontentloaded');

    // Wait for editor toolbar to be visible
    await page.waitForSelector('.btn-tsunade', { timeout: 15_000 });
  }

  test('TC-TB3-1: login and reach ProcessEditor', async ({ page }) => {
    await loginAndGoToEditor(page);
    await expect(page.locator('.btn-tsunade')).toBeVisible();
  });

  test('TC-TB3-2: Tsunade panel opens on button click', async ({ page }) => {
    await loginAndGoToEditor(page);

    // Open Tsunade panel
    await page.locator('.btn-tsunade').click();
    await expect(page.locator('.tsunade-panel')).toBeVisible({ timeout: 5_000 });

    // Input and send button should be present
    await expect(page.locator('.tsunade-input')).toBeVisible();
    await expect(page.locator('.tsunade-send')).toBeVisible();
  });

  test('TC-TB3-3: can type and send a message to Tsunade', async ({ page }) => {
    await loginAndGoToEditor(page);

    // Open Tsunade
    await page.locator('.btn-tsunade').click();
    await expect(page.locator('.tsunade-panel')).toBeVisible({ timeout: 5_000 });

    // Type message
    await page.locator('.tsunade-input').fill('Опиши этот процесс');
    await expect(page.locator('.tsunade-send')).toBeEnabled();

    // Send
    await page.locator('.tsunade-send').click();

    // Verify loading state or actual response appears (either "Думаю…" or an assistant message)
    await expect(
      page.locator('.tsunade-msg.assistant')
    ).toBeVisible({ timeout: 30_000 });
  });

  test('TC-TB3-4: Tsunade panel closes on ✕ click', async ({ page }) => {
    await loginAndGoToEditor(page);

    await page.locator('.btn-tsunade').click();
    await expect(page.locator('.tsunade-panel')).toBeVisible({ timeout: 5_000 });

    await page.locator('.tsunade-btn-close').click();
    await expect(page.locator('.tsunade-panel')).not.toBeVisible({ timeout: 3_000 });
  });

});
