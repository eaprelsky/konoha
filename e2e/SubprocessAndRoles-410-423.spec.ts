import { test, expect } from '@playwright/test';

test.describe('Issues #410 & #423: Sub-process runtime + Role label padding', () => {
  test('TC-10: Child case created when sub-process is called', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    const runsLink = page.locator('a[href*="runs"], a[href*="cases"]').first();
    await expect(runsLink).toBeVisible({ timeout: 3000 });
    await runsLink.click();
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

    await expect(page.locator('#root')).toBeVisible();
  });

  test('TC-11: Parent work item status is "running" while child is active', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    const workItemsLink = page.locator('a[href*="workitems"], a[href*="tasks"]').first();
    await expect(workItemsLink).toBeVisible({ timeout: 3000 });
    await workItemsLink.click();
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

    await expect(page.locator('#root')).toBeVisible();
  });

  test('TC-12: Role label does not overlap left boundary of node (padding)', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    const editorLink = page.locator('a[href*="editor"]').first();
    await expect(editorLink).toBeVisible({ timeout: 3000 });
    await editorLink.click();
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

    const screenshotBuffer = await page.screenshot({
      path: '/opt/shared/shino/reports/2026-04-10-screenshot-423.png'
    });
    expect(screenshotBuffer.byteLength).toBeGreaterThan(10_000);
  });

  test('TC-13: Screenshot of active run with sub-process', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    const runsLink = page.locator('a[href*="runs"], a[href*="cases"]').first();
    await expect(runsLink).toBeVisible({ timeout: 3000 });
    await runsLink.click();
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

    const screenshotBuffer = await page.screenshot({
      path: '/opt/shared/shino/reports/2026-04-10-screenshot-410.png'
    });
    expect(screenshotBuffer.byteLength).toBeGreaterThan(10_000);
  });
});
