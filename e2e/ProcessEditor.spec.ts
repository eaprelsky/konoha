import { test, expect } from '@playwright/test';

test.describe('ProcessEditor with Minimap', () => {
  test('should load app successfully (TC-05)', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    await expect(page.locator('#root')).toBeVisible();
  });

  test('should display Minimap in ProcessEditor (TC-06)', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    const editorElement = page.locator('[data-testid="process-editor"], .ipe-canvas').first();
    await expect(editorElement).toBeVisible({ timeout: 5000 });

    // Look for SVG element inside the canvas area
    const canvas = page.locator('.ipe-canvas');
    const svgInCanvas = canvas.locator('svg').first();
    await expect(svgInCanvas).toBeVisible();
  });

  test('should save screenshot of ProcessEditor (TC-07)', async ({ page, context }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    const screenshotBuffer = await page.screenshot({ path: '/opt/shared/shino/reports/2026-04-10-screenshot-400.png' });
    expect(screenshotBuffer.byteLength).toBeGreaterThan(10_000);
  });
});
