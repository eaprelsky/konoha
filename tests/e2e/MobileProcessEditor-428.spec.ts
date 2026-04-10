import { test, expect } from '@playwright/test';

test.describe('MobileProcessEditor-428', () => {
  let editorId: string;

  test.beforeAll(async ({ request }) => {
    // TC-01: POST /workflows → 201 with real UUID
    const response = await request.post('/workflows', {
      data: { draft: true },
      headers: {
        'Authorization': `Bearer ${process.env.KONOHA_TOKEN ?? 'konoha-dev-token'}`
      }
    });

    expect(response.status()).toBe(201);
    const json = await response.json();
    editorId = json.id;

    // Verify real UUID (not e2e-fallback)
    expect(editorId).toBeTruthy();
    expect(editorId).not.toMatch(/e2e-.*-fallback/);
  });

  test('TC-02: /ui/editor/<id> loads without 404 or /login redirect', async ({ page }) => {
    const response = await page.goto(`/ui/editor/${editorId}`);

    expect(response?.status()).toBe(200);
    expect(page.url()).not.toContain('/ui/login');
    expect(page.url()).toContain(`/ui/editor/${editorId}`);
  });

  test('TC-03: .ipe-canvas found (editor rendered)', async ({ page }) => {
    await page.goto(`/ui/editor/${editorId}`);

    const canvas = page.locator('.ipe-canvas');
    await expect(canvas).toBeVisible({ timeout: 10000 });
  });

  test('TC-04: .mob-side-sheet visible at 390x844 (#428)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/ui/editor/${editorId}`);

    const sideSheet = page.locator('.mob-side-sheet');
    await expect(sideSheet).toBeVisible({ timeout: 5000 });
  });

  test('TC-05: .mob-side-toggle clickable (#428)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/ui/editor/${editorId}`);

    const toggle = page.locator('.mob-side-toggle');
    await expect(toggle).toBeVisible({ timeout: 5000 });
    await expect(toggle).toBeEnabled();
  });

  test('TC-06: .mob-palette available (#428)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/ui/editor/${editorId}`);

    const palette = page.locator('.mob-palette');
    await expect(palette).toBeVisible({ timeout: 5000 });
  });

  test('TC-07: Clean build + screenshot (not 404)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/ui/editor/${editorId}`);

    // Verify page is loaded correctly
    const canvas = page.locator('.ipe-canvas');
    await expect(canvas).toBeVisible({ timeout: 10000 });

    // Take screenshot
    await page.screenshot({ path: '/opt/shared/shino/reports/tc-07-editor-screenshot.png' });

    // Verify it's not 404
    const pageContent = await page.content();
    expect(pageContent).not.toContain('404');
    expect(pageContent).toContain('ipe-canvas');
  });
});
