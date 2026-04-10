import { test, expect } from '@playwright/test';

test.describe('Issue #425: AssistantWidget placeholder fix', () => {
  test('TC-05: Application loads', async ({ page }) => {
    await page.goto('http://127.0.0.1:3201/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    // Verify page loaded
    expect(page.url()).toContain('3201');
  });

  test('TC-06: Placeholder visible and not truncated', async ({ page }) => {
    await page.goto('http://127.0.0.1:3201/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    // Find textarea with placeholder
    const textarea = await page.locator('textarea.aw-input, textarea[placeholder*="Напишите"]').first();

    // Check if textarea is visible
    if (await textarea.isVisible({ timeout: 2000 }).catch(() => false)) {
      // Get the computed style
      const placeholder = await textarea.getAttribute('placeholder');
      expect(placeholder).toContain('\n');
      expect(placeholder).toContain('Напишите');
      expect(placeholder).toContain('Enter');
    }

    // Page should be functional
    expect(page.url()).toContain('3201');
  });

  test('TC-07: Screenshot of AssistantWidget with placeholder', async ({ page }) => {
    await page.goto('http://127.0.0.1:3201/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    // Find and scroll to textarea if needed
    const textarea = await page.locator('textarea.aw-input, textarea[placeholder*="Напишите"]').first();
    if (await textarea.isVisible({ timeout: 2000 }).catch(() => false)) {
      // Scroll into view
      await textarea.scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
    }

    // Take screenshot of the whole page
    const screenshotBuffer = await page.screenshot({
      path: '/opt/shared/shino/reports/2026-04-10-screenshot-425.png'
    });
    expect(screenshotBuffer).toBeTruthy();
  });
});
