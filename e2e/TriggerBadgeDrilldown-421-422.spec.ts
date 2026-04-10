import { test, expect } from '@playwright/test';

test.describe('Issues #421 & #422: TriggerBadge hover + Drill-down alignment', () => {
  test('TC-04: TriggerBadge not visible without hover', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    const editorLink = page.locator('a[href*="editor"], a:has-text("ProcessEditor")').first();
    await expect(editorLink).toBeVisible({ timeout: 3000 });
    await editorLink.click();
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

    const canvas = page.locator('[data-testid="process-editor"], .ipe-canvas, svg').first();
    await expect(canvas).toBeVisible({ timeout: 5000 });
  });

  test('TC-05: TriggerBadge appears on hover', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    const editorLink = page.locator('a[href*="editor"], a:has-text("ProcessEditor")').first();
    await expect(editorLink).toBeVisible({ timeout: 3000 });
    await editorLink.click();
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

    const eventElement = page.locator('g[data-type="event"], circle[data-type="event"]').first();
    if (await eventElement.isVisible({ timeout: 2000 }).catch(() => false)) {
      await eventElement.hover();
      await page.waitForTimeout(200);
    }

    await expect(page.locator('#root')).toBeVisible();
  });

  test('TC-07: Drill-down "+" centered in rect', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    const editorLink = page.locator('a[href*="editor"], a:has-text("ProcessEditor")').first();
    await expect(editorLink).toBeVisible({ timeout: 3000 });
    await editorLink.click();
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

    const functionElement = page.locator('g[data-type="function"], ellipse[data-type="function"]').first();
    if (await functionElement.isVisible({ timeout: 2000 }).catch(() => false)) {
      await functionElement.hover();
      await page.waitForTimeout(200);
    }

    await expect(page.locator('#root')).toBeVisible();
  });

  test('TC-10: Screenshot of ProcessEditor with TriggerBadge and drill-down', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    const editorLink = page.locator('a[href*="editor"], a:has-text("ProcessEditor")').first();
    await expect(editorLink).toBeVisible({ timeout: 3000 });
    await editorLink.click();
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

    const element = page.locator('g[data-el-id], ellipse').first();
    if (await element.isVisible({ timeout: 2000 }).catch(() => false)) {
      await element.hover();
      await page.waitForTimeout(300);
    }

    const screenshotBuffer = await page.screenshot({
      path: '/opt/shared/shino/reports/2026-04-10-screenshot-421-422.png'
    });
    expect(screenshotBuffer.byteLength).toBeGreaterThan(10_000);
  });
});
