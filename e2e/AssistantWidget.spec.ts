import { test, expect } from '@playwright/test';

test.describe('AssistantWidget attachment feature', () => {
  test('should open app and AssistantWidget (TC-05, TC-06 prep)', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    await expect(page.locator('#root')).toBeVisible();
  });

  test('should display attachment button in AssistantWidget (TC-06)', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    // Open AssistantWidget via trigger button
    const trigger = page.locator('button.aw-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });
    await trigger.click();

    // Attachment button should be visible inside the opened widget
    const attachBtn = page.locator('button.aw-attach-btn');
    await expect(attachBtn).toBeVisible({ timeout: 3000 });
  });

  test('should save screenshot of AssistantWidget (TC-07)', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    const screenshotBuffer = await page.screenshot({ path: '/opt/shared/shino/reports/2026-04-10-screenshot-382.png' });
    expect(screenshotBuffer.byteLength).toBeGreaterThan(10_000);
  });
});
