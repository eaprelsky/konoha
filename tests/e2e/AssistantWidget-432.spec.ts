import { test, expect } from '@playwright/test';

test.describe('AssistantWidget-432', () => {
  let editorId: string;

  test.beforeAll(async ({ request }) => {
    // TC-08: POST /workflows → 201 with real UUID
    const response = await request.post('/workflows', {
      data: { draft: true },
      headers: {
        'Authorization': `Bearer ${process.env.KONOHA_TOKEN ?? 'konoha-dev-token'}`
      }
    });

    expect(response.status()).toBe(201);
    const json = await response.json();
    editorId = json.id;

    expect(editorId).toBeTruthy();
    expect(editorId).not.toMatch(/e2e-.*-fallback/);
  });

  test('TC-09: .aw-panel visible as bottom sheet ~50vh (#432)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/ui/editor/${editorId}`);

    const awPanel = page.locator('.aw-panel');
    await expect(awPanel).toBeVisible({ timeout: 5000 });

    // Check height is approximately 50vh (expect ~400-450px on 844px viewport)
    const panelBox = await awPanel.boundingBox();
    expect(panelBox?.height ?? 0).toBeGreaterThan(350);
    expect(panelBox?.height ?? 0).toBeLessThan(500);
  });

  test('TC-10: .aw-drag-handle present (#432)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/ui/editor/${editorId}`);

    const dragHandle = page.locator('.aw-drag-handle');
    await expect(dragHandle).toBeVisible({ timeout: 5000 });
  });

  test('TC-11: drag handle draggable 25-90% (#432)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/ui/editor/${editorId}`);

    const dragHandle = page.locator('.aw-drag-handle');
    await expect(dragHandle).toBeVisible({ timeout: 5000 });

    // Simulate drag: from 50% to 90% (upward)
    const handleBox = await dragHandle.boundingBox();
    if (handleBox) {
      const startY = handleBox.y + handleBox.height / 2;
      const startX = handleBox.x + handleBox.width / 2;
      const endY = 200; // Move upward to ~90% of viewport

      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(startX, endY, { steps: 10 });
      await page.mouse.up();

      // Check panel adjusted
      const awPanel = page.locator('.aw-panel');
      const panelBox = await awPanel.boundingBox();
      expect(panelBox?.height ?? 0).toBeLessThan(350);
    }
  });

  test('TC-12: fullscreen toggling (#432)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/ui/editor/${editorId}`);

    const awPanel = page.locator('.aw-panel');
    const fullscreenBtn = page.locator('.aw-hbtn');

    await expect(awPanel).toBeVisible({ timeout: 5000 });
    const initialHeight = (await awPanel.boundingBox())?.height;

    // Click fullscreen button
    await fullscreenBtn.click();
    await page.waitForTimeout(500);

    // Panel should now be expanded
    const expandedHeight = (await awPanel.boundingBox())?.height;
    expect((expandedHeight ?? 0) > (initialHeight ?? 0)).toBeTruthy();

    // Click again to restore
    await fullscreenBtn.click();
    await page.waitForTimeout(500);

    const restoredHeight = (await awPanel.boundingBox())?.height;
    expect(Math.abs((restoredHeight ?? 0) - (initialHeight ?? 0))).toBeLessThan(50);
  });

  test('TC-13: safe-area in .aw-panel.expanded (#433)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/ui/editor/${editorId}`);

    // Expand panel first
    const fullscreenBtn = page.locator('.aw-hbtn');
    await fullscreenBtn.click();
    await page.waitForTimeout(500);

    const awPanel = page.locator('.aw-panel.expanded');
    const computed = await awPanel.evaluate((el) => {
      return window.getComputedStyle(el).paddingBottom;
    });

    const paddingValue = parseFloat(computed);
    expect(paddingValue).toBeGreaterThanOrEqual(16);
  });

  test('TC-14: resize 390→1280 → isMobile=false', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/ui/editor/${editorId}`);

    const awPanel = page.locator('.aw-panel');
    await expect(awPanel).toBeVisible({ timeout: 5000 });

    // Resize to desktop
    await page.setViewportSize({ width: 1280, height: 800 });

    // Panel should no longer be visible on desktop (bottom sheet is mobile-only)
    await expect(awPanel).not.toBeVisible({ timeout: 5000 });
  });
});
