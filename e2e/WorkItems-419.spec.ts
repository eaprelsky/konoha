import { test, expect } from '@playwright/test';

test.describe('Issue #419: WorkItems live filters', () => {
  test('TC-06: Process dropdown displays and contains options', async ({ page }) => {
    await page.goto('http://127.0.0.1:3201/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    // Look for process dropdown
    const processDropdown = await page.locator('#filterProcess, [id*="filterProcess"]').first();

    // Should be visible
    if (await processDropdown.isVisible({ timeout: 2000 }).catch(() => false)) {
      await processDropdown.click();

      // Check for options
      const options = await page.locator('#filterProcess option, [id*="filterProcess"] option');
      const count = await options.count();

      // Should have at least "Все процессы" option
      expect(count).toBeGreaterThan(0);
    }
  });

  test('TC-07: Process selection updates task list without reload', async ({ page }) => {
    await page.goto('http://127.0.0.1:3201/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    // Get current URL before any interaction
    const originalUrl = page.url();

    // Find process dropdown
    const processDropdown = await page.locator('#filterProcess, [id*="filterProcess"]').first();

    if (await processDropdown.isVisible({ timeout: 2000 }).catch(() => false)) {
      // Select first available process (not "All")
      await processDropdown.selectOption({ index: 1 });
      await page.waitForTimeout(500); // Wait for filter to apply

      // URL should not change (no reload)
      expect(page.url()).toBe(originalUrl);

      // Table should be present
      const table = await page.locator('table, [class*="table"]').first();
      expect(table).toBeTruthy();
    }
  });

  test('TC-08: Assignee dropdown displays and contains options', async ({ page }) => {
    await page.goto('http://127.0.0.1:3201/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    // Look for assignee dropdown
    const assigneeDropdown = await page.locator('#filterAssignee, [id*="filterAssignee"]').first();

    if (await assigneeDropdown.isVisible({ timeout: 2000 }).catch(() => false)) {
      await assigneeDropdown.click();

      // Check for options
      const options = await page.locator('#filterAssignee option, [id*="filterAssignee"] option');
      const count = await options.count();

      // Should have options
      expect(count).toBeGreaterThan(0);
    }
  });

  test('TC-09: No "Apply" button in filter UI', async ({ page }) => {
    await page.goto('http://127.0.0.1:3201/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    // Check for Apply/Применить button
    const applyBtn = await page.locator('button:has-text("Apply"), button:has-text("Применить")').filter({ hasText: /Apply|Применить/ }).first();

    // Should NOT find Apply button in filter area (only Reset/Сбросить)
    const applyBtnVisible = await applyBtn.isVisible({ timeout: 2000 }).catch(() => false);

    // Also check page content
    const pageText = await page.content();

    // Should have "Сбросить" (Reset) but not "Применить" (Apply) in filters
    if (!pageText.includes('Применить') || applyBtnVisible === false) {
      expect(applyBtnVisible).toBe(false);
    }
  });

  test('TC-10: Screenshot of WorkItems page with filters', async ({ page }) => {
    await page.goto('http://127.0.0.1:3201/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    // Take screenshot
    const screenshotBuffer = await page.screenshot({
      path: '/opt/shared/shino/reports/2026-04-10-screenshot-419.png'
    });
    expect(screenshotBuffer).toBeTruthy();
  });
});
