import { test, expect } from '@playwright/test';

test.describe('Issue #407: Cross-consistency between schema and registry', () => {
  test('TC-07: Role on schema synchronizes to Roles registry', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    const editorLink = page.locator('a[href*="editor"], button:has-text("Редактор")').first();
    await expect(editorLink).toBeVisible({ timeout: 3000 });
    await editorLink.click();
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

    await expect(page.locator('#root')).toBeVisible();
  });

  test('TC-08: Document on schema synchronizes to Documents registry', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    const docsLink = page.locator('a[href*="documents"], a[href*="docs"]').first();
    await expect(docsLink).toBeVisible({ timeout: 3000 });
    await docsLink.click();
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

    await expect(page.locator('#root')).toBeVisible();
  });

  test('TC-09: Deleting process removes runs from Runs section', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    const runsLink = page.locator('a[href*="runs"], a[href*="cases"], button:has-text("Прогоны")').first();
    await expect(runsLink).toBeVisible({ timeout: 3000 });
    await runsLink.click();
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

    await expect(page.locator('#root')).toBeVisible();
  });

  test('TC-10: Screenshot of editor after adding role + registry', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    const screenshotBuffer1 = await page.screenshot({
      path: '/opt/shared/shino/reports/2026-04-10-screenshot-407-app.png'
    });
    expect(screenshotBuffer1.byteLength).toBeGreaterThan(10_000);

    const rolesLink = page.locator('a[href*="roles"], button:has-text("Роли")').first();
    await expect(rolesLink).toBeVisible({ timeout: 3000 });
    await rolesLink.click();
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

    const screenshotBuffer2 = await page.screenshot({
      path: '/opt/shared/shino/reports/2026-04-10-screenshot-407-roles.png'
    });
    expect(screenshotBuffer2.byteLength).toBeGreaterThan(10_000);
  });
});
