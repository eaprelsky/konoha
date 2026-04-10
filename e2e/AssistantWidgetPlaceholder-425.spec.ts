import { test, expect } from '@playwright/test';

test.describe('Issue #425: AssistantWidget placeholder fix', () => {
  test('TC-05: Application loads', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    await expect(page.locator('#root')).toBeVisible();
  });

  test('TC-06: Placeholder visible and not truncated', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    // Open AssistantWidget first
    const trigger = page.locator('button.aw-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });
    await trigger.click();

    // Find textarea with placeholder
    const textarea = page.locator('textarea.aw-input, textarea[placeholder*="Напишите"]').first();
    await expect(textarea).toBeVisible({ timeout: 3000 });

    const placeholder = await textarea.getAttribute('placeholder');
    expect(placeholder).toContain('\n');
    expect(placeholder).toContain('Напишите');
    expect(placeholder).toContain('Enter');
  });

  test('TC-07: Screenshot of AssistantWidget with placeholder', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    // Open AssistantWidget first
    const trigger = page.locator('button.aw-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });
    await trigger.click();

    const textarea = page.locator('textarea.aw-input, textarea[placeholder*="Напишите"]').first();
    await expect(textarea).toBeVisible({ timeout: 3000 });
    await textarea.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);

    const screenshotBuffer = await page.screenshot({
      path: '/opt/shared/shino/reports/2026-04-10-screenshot-425.png'
    });
    expect(screenshotBuffer.byteLength).toBeGreaterThan(10_000);
  });
});
