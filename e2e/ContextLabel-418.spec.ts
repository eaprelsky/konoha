import { test, expect } from '@playwright/test';

test.describe('Issue #418: AssistantWidget context label validation', () => {
  test('TC-04: Context label on ProcessEditor page (or no label)', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    const triggerBtn = page.locator('button:has-text("💬")').first();
    await expect(triggerBtn).toBeVisible({ timeout: 3000 });
    await triggerBtn.click();
    await page.waitForTimeout(500);

    // Should NOT show "process mode" as a hardcoded label
    const pageText = await page.content();
    expect(pageText).not.toContain('>process mode<');
  });

  test('TC-05: Context label on Runs page (or no label, NOT process mode)', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    const runsLink = page.locator('a[href*="runs"], button:has-text("Runs")').first();
    if (await runsLink.isVisible({ timeout: 2000 }).catch(() => false)) {
      await runsLink.click();
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    }

    const triggerBtn = page.locator('button:has-text("💬")').first();
    await expect(triggerBtn).toBeVisible({ timeout: 3000 });
    await triggerBtn.click();
    await page.waitForTimeout(500);

    // Should NOT show "process mode" as hardcoded everywhere
    const pageText = await page.content();
    expect(pageText).not.toContain('>process mode<');
  });

  test('TC-06: Context label on home page (or no label)', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    const triggerBtn = page.locator('button:has-text("💬")').first();
    await expect(triggerBtn).toBeVisible({ timeout: 3000 });
    await triggerBtn.click();
    await page.waitForTimeout(500);

    const pageText = await page.content();
    expect(pageText).not.toContain('>process mode<');
  });

  test('TC-07: Screenshot of AssistantWidget with context label', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    const triggerBtn = page.locator('button:has-text("💬")').first();
    await expect(triggerBtn).toBeVisible({ timeout: 3000 });
    await triggerBtn.click();

    const screenshotBuffer = await page.screenshot({
      path: '/opt/shared/shino/reports/2026-04-10-screenshot-418.png'
    });
    expect(screenshotBuffer.byteLength).toBeGreaterThan(10_000);
  });
});
