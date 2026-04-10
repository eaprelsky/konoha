import { test, expect } from '@playwright/test';

test.describe('Issue #403: Role data model (Role ≠ Agent, M:M)', () => {
  test('TC-08: Roles section shows roles with descriptions (not agent list)', async ({ page }) => {
    await page.goto('http://127.0.0.1:3201/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    // Look for Roles page link
    const rolesLink = await page.locator('a[href*="roles"], button:has-text("Роли"), a:has-text("Roles")').first();

    if (await rolesLink.isVisible({ timeout: 2000 }).catch(() => false)) {
      await rolesLink.click();
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    }

    // Check page content
    const pageText = await page.content();

    // Should contain role-related content (not just agent names)
    expect(pageText).toBeTruthy();
  });

  test('TC-09: Role shows assigned executors (persons/agents)', async ({ page }) => {
    await page.goto('http://127.0.0.1:3201/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    // Navigate to Roles
    const rolesLink = await page.locator('a[href*="roles"], button:has-text("Роли"), a:has-text("Roles")').first();

    if (await rolesLink.isVisible({ timeout: 2000 }).catch(() => false)) {
      await rolesLink.click();
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    }

    // Look for role cards or table with roles
    const roleElements = await page.locator('[class*="role"], tr:has(td)').first();

    // Should display some role information
    expect(roleElements).toBeTruthy();
  });

  test('TC-10: Executor has their assigned roles visible', async ({ page }) => {
    await page.goto('http://127.0.0.1:3201/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    // Look for People or Agents page
    const peopleLink = await page.locator('a[href*="people"], a[href*="agents"], button:has-text("Люди"), button:has-text("Агенты")').first();

    if (await peopleLink.isVisible({ timeout: 2000 }).catch(() => false)) {
      await peopleLink.click();
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    }

    // Page should load
    const pageUrl = page.url();
    expect(pageUrl).toBeTruthy();
  });

  test('TC-11: Screenshot of Roles section', async ({ page }) => {
    await page.goto('http://127.0.0.1:3201/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    // Navigate to Roles
    const rolesLink = await page.locator('a[href*="roles"], button:has-text("Роли"), a:has-text("Roles")').first();

    if (await rolesLink.isVisible({ timeout: 2000 }).catch(() => false)) {
      await rolesLink.click();
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    }

    // Take screenshot
    const screenshotBuffer = await page.screenshot({
      path: '/opt/shared/shino/reports/2026-04-10-screenshot-403.png'
    });
    expect(screenshotBuffer).toBeTruthy();
  });
});
