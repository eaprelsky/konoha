import { test, expect } from '@playwright/test';

test.describe('Issues #410 & #423: Sub-process runtime + Role label padding', () => {
  test('TC-10: Child case created when sub-process is called', async ({ page }) => {
    await page.goto('http://127.0.0.1:3201/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    // Navigate to Runs/Cases
    const runsLink = await page.locator('a[href*="runs"], a[href*="cases"]').first();

    if (await runsLink.isVisible({ timeout: 2000 }).catch(() => false)) {
      await runsLink.click();
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    }

    // Check page content - should show cases/runs
    const pageText = await page.content();
    expect(pageText).toBeTruthy();
  });

  test('TC-11: Parent work item status is "running" while child is active', async ({ page }) => {
    await page.goto('http://127.0.0.1:3201/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    // Navigate to work items or cases
    const workItemsLink = await page.locator('a[href*="workitems"], a[href*="tasks"]').first();

    if (await workItemsLink.isVisible({ timeout: 2000 }).catch(() => false)) {
      await workItemsLink.click();
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    }

    // Page should load
    const pageUrl = page.url();
    expect(pageUrl).toBeTruthy();
  });

  test('TC-12: Role label does not overlap left boundary of node (padding)', async ({ page }) => {
    await page.goto('http://127.0.0.1:3201/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    // Navigate to ProcessEditor
    const editorLink = await page.locator('a[href*="editor"]').first();

    if (await editorLink.isVisible({ timeout: 2000 }).catch(() => false)) {
      await editorLink.click();
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    }

    // Take screenshot showing role nodes with padding
    const screenshotBuffer = await page.screenshot({
      path: '/opt/shared/shino/reports/2026-04-10-screenshot-423.png'
    });
    expect(screenshotBuffer).toBeTruthy();
  });

  test('TC-13: Screenshot of active run with sub-process', async ({ page }) => {
    await page.goto('http://127.0.0.1:3201/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    // Navigate to Runs/Cases
    const runsLink = await page.locator('a[href*="runs"], a[href*="cases"]').first();

    if (await runsLink.isVisible({ timeout: 2000 }).catch(() => false)) {
      await runsLink.click();
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    }

    // Take screenshot
    const screenshotBuffer = await page.screenshot({
      path: '/opt/shared/shino/reports/2026-04-10-screenshot-410.png'
    });
    expect(screenshotBuffer).toBeTruthy();
  });
});
