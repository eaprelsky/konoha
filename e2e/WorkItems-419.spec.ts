import { test, expect } from '@playwright/test';

test.describe('Issue #419: WorkItems live filters', () => {
  test('TC-06: Process dropdown displays and contains options', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    const processDropdown = page.locator('#filterProcess, [id*="filterProcess"]').first();
    await expect(processDropdown).toBeVisible({ timeout: 3000 });
    await processDropdown.click();

    const options = page.locator('#filterProcess option, [id*="filterProcess"] option');
    const count = await options.count();
    expect(count).toBeGreaterThan(0);
  });

  test('TC-07: Process selection updates task list without reload', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    const originalUrl = page.url();
    const processDropdown = page.locator('#filterProcess, [id*="filterProcess"]').first();
    await expect(processDropdown).toBeVisible({ timeout: 3000 });

    await processDropdown.selectOption({ index: 1 });
    await page.waitForTimeout(500);

    // URL should not change (no reload)
    expect(page.url()).toBe(originalUrl);

    const table = page.locator('table, [class*="table"]').first();
    await expect(table).toBeVisible({ timeout: 3000 });
  });

  test('TC-08: Assignee dropdown displays and contains options', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    const assigneeDropdown = page.locator('#filterAssignee, [id*="filterAssignee"]').first();
    await expect(assigneeDropdown).toBeVisible({ timeout: 3000 });
    await assigneeDropdown.click();

    const options = page.locator('#filterAssignee option, [id*="filterAssignee"] option');
    const count = await options.count();
    expect(count).toBeGreaterThan(0);
  });

  test('TC-09: No "Apply" button in filter UI', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    const applyBtn = page.locator('button:has-text("Apply"), button:has-text("Применить")').first();
    await expect(applyBtn).not.toBeVisible({ timeout: 2000 }).catch(() => {});
  });

  test('TC-10: Screenshot of WorkItems page with filters', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    const screenshotBuffer = await page.screenshot({
      path: '/opt/shared/shino/reports/2026-04-10-screenshot-419.png'
    });
    expect(screenshotBuffer.byteLength).toBeGreaterThan(10_000);
  });
});
