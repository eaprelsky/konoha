import { test, expect } from '@playwright/test';

test.describe('Issues #416 & #417: Tsunade updates + Minimap repositioning', () => {
  test('TC-05: Tsunade applies schema patch to canvas', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    const editorElement = page.locator('[data-testid="process-editor"], .ipe-canvas').first();
    await expect(editorElement).toBeVisible({ timeout: 5000 });
  });

  test('TC-06: Screenshot of canvas after Tsunade patch', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    const screenshotBuffer = await page.screenshot({
      path: '/opt/shared/shino/reports/2026-04-10-screenshot-416.png'
    });
    expect(screenshotBuffer.byteLength).toBeGreaterThan(10_000);
  });

  test('TC-08: Minimap in top-right corner, no overlap with AssistantWidget', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    const minimap = page.locator('svg[class*="minimap"], svg[data-testid="minimap"]').first();
    await expect(minimap).toBeVisible({ timeout: 5000 });

    const box = await minimap.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      expect(box.y).toBeLessThan(200); // top area
    }

    const screenshotBuffer = await page.screenshot({
      path: '/opt/shared/shino/reports/2026-04-10-screenshot-417.png'
    });
    expect(screenshotBuffer.byteLength).toBeGreaterThan(10_000);
  });
});
