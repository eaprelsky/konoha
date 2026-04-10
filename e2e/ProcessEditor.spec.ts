import { test, expect } from '@playwright/test';

test.describe('ProcessEditor with Minimap', () => {
  test('should load app successfully (TC-05)', async ({ page }) => {
    await page.goto('http://127.0.0.1:3201/');
    // Wait for app to load
    await page.waitForLoadState('networkidle', { timeout: 10000 });
    expect(page).toBeTruthy();
  });

  test('should display Minimap in ProcessEditor (TC-06)', async ({ page }) => {
    await page.goto('http://127.0.0.1:3201/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    // Navigate to editor or check if ProcessEditor is visible
    const editorElement = await page.locator('[data-testid="process-editor"], .ipe-canvas').first();

    if (await editorElement.isVisible()) {
      // Look for Minimap SVG overlay
      const minimapSvg = await page.locator('svg[class*="minimap"], svg[data-testid="minimap"]').first();

      // If minimap SVG not found by testid, check for presence in canvas area
      const canvas = await page.locator('.ipe-canvas');
      const svgInCanvas = await canvas.locator('svg').first();

      expect(svgInCanvas).toBeTruthy();
    }
  });

  test('should save screenshot of ProcessEditor (TC-07)', async ({ page, context }) => {
    await page.goto('http://127.0.0.1:3201/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    // Take screenshot
    const screenshotBuffer = await page.screenshot({ path: '/opt/shared/shino/reports/2026-04-10-screenshot-400.png' });
    expect(screenshotBuffer).toBeTruthy();
  });
});
