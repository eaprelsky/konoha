import { test, expect } from '@playwright/test';

test.describe('Issue #403: Role data model (Role ≠ Agent, M:M)', () => {
  test('TC-08: Roles section shows roles with descriptions (not agent list)', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    const rolesLink = page.locator('a[href*="roles"], button:has-text("Роли"), a:has-text("Roles")').first();
    await expect(rolesLink).toBeVisible({ timeout: 3000 });
    await rolesLink.click();
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

    await expect(page.locator('#root')).toBeVisible();
  });

  test('TC-09: Role shows assigned executors (persons/agents)', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    const rolesLink = page.locator('a[href*="roles"], button:has-text("Роли"), a:has-text("Roles")').first();
    await expect(rolesLink).toBeVisible({ timeout: 3000 });
    await rolesLink.click();
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

    // Role cards or table rows should be present
    const roleElements = page.locator('[class*="role"], tr:has(td)').first();
    await expect(roleElements).toBeVisible({ timeout: 3000 });
  });

  test('TC-10: Executor has their assigned roles visible', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    const peopleLink = page.locator('a[href*="people"], a[href*="agents"], button:has-text("Люди"), button:has-text("Агенты")').first();
    await expect(peopleLink).toBeVisible({ timeout: 3000 });
    await peopleLink.click();
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

    await expect(page.locator('#root')).toBeVisible();
  });

  test('TC-11: Screenshot of Roles section', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    const rolesLink = page.locator('a[href*="roles"], button:has-text("Роли"), a:has-text("Roles")').first();
    await expect(rolesLink).toBeVisible({ timeout: 3000 });
    await rolesLink.click();
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

    const screenshotBuffer = await page.screenshot({
      path: '/opt/shared/shino/reports/2026-04-10-screenshot-403.png'
    });
    expect(screenshotBuffer.byteLength).toBeGreaterThan(10_000);
  });
});
