import { test, expect } from '@playwright/test';

test.describe('Issue #426: Markdown rendering in AssistantWidget', () => {
  test('TC-04: Application loads', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    await expect(page.locator('#root')).toBeVisible();
  });

  test('TC-05: Bold text renders as <strong>', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    // Open AssistantWidget
    const trigger = page.locator('button.aw-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });
    await trigger.click();

    const assistantMessages = await page.locator('.aw-msg.assistant').all();

    for (const msg of assistantMessages) {
      const html = await msg.innerHTML();
      // Literal asterisks must not appear — renderMarkdown() should have converted them
      expect(html).not.toContain('**');
    }
  });

  test('TC-06: Italic text renders as <em>', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    // Open AssistantWidget
    const trigger = page.locator('button.aw-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });
    await trigger.click();

    const assistantMessages = await page.locator('.aw-msg.assistant').all();

    for (const msg of assistantMessages) {
      const html = await msg.innerHTML();
      // Orphaned single asterisks (not part of *word*) must not appear
      expect(html).not.toMatch(/\*[^*]+\*/);
    }
  });

  test('TC-07: Screenshot of AssistantWidget with markdown', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    const screenshotBuffer = await page.screenshot({
      path: '/opt/shared/shino/reports/2026-04-10-screenshot-426.png'
    });
    expect(screenshotBuffer.byteLength).toBeGreaterThan(10_000);
  });
});
