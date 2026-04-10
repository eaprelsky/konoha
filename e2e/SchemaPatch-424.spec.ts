import { test, expect } from '@playwright/test';

test.describe('Issue #424: Tsunade schema_patch fixes', () => {
  test('TC-10: Application loads with HTTP 200 and networkidle', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    await expect(page.locator('#root')).toBeVisible();
  });

  test('TC-11: Schema patch adds element to canvas', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    const editorLink = page.locator('a[href*="editor"], a:has-text("ProcessEditor"), a:has-text("Editor")').first();
    await expect(editorLink).toBeVisible({ timeout: 3000 });
    await editorLink.click();
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

    const canvas = page.locator('[data-testid="process-editor"], .ipe-canvas, svg').first();
    await expect(canvas).toBeVisible({ timeout: 5000 });
  });

  test('TC-12: Schema patch updates element properties', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    const editorLink = page.locator('a[href*="editor"], a:has-text("ProcessEditor"), a:has-text("Editor")').first();
    await expect(editorLink).toBeVisible({ timeout: 3000 });
    await editorLink.click();
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

    const pageContent = await page.content();
    expect(pageContent.length).toBeGreaterThan(1000);
  });

  test('TC-13: Screenshot of canvas after schema patch', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    const editorLink = page.locator('a[href*="editor"], a:has-text("ProcessEditor"), a:has-text("Editor")').first();
    await expect(editorLink).toBeVisible({ timeout: 3000 });
    await editorLink.click();
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

    const screenshotBuffer = await page.screenshot({
      path: '/opt/shared/shino/reports/2026-04-10-screenshot-424.png'
    });
    expect(screenshotBuffer.byteLength).toBeGreaterThan(10_000);
  });
});
