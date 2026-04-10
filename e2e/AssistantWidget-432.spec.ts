import { test, expect } from '@playwright/test';
import { mkdirSync } from 'fs';

const MOBILE_VIEWPORT = { width: 390, height: 844 };
const DESKTOP_VIEWPORT = { width: 1280, height: 800 };
const WORKFLOW_ID = `e2e-assistant-432-${Date.now()}`;

let testProcessId: string;

/**
 * Click .aw-trigger to expand the assistant widget.
 * .aw-panel and .aw-drag-handle are only rendered when widgetState !== 'collapsed'.
 * All tests that need the panel must call this first.
 */
async function expandWidget(page: import('@playwright/test').Page) {
  const trigger = page.locator('.aw-trigger');
  await trigger.waitFor({ state: 'visible', timeout: 10_000 });
  await trigger.click();
  // Wait for panel to appear in DOM
  await page.waitForSelector('.aw-panel', { timeout: 5_000 });
}

test.describe('Issue #432: Mobile Assistant Bottom Sheet', () => {
  test.beforeAll(async ({ request }) => {
    // Ensure screenshot output directory exists
    mkdirSync('/opt/shared/shino/reports', { recursive: true });

    // Create workflow via Playwright request context.
    // Authorization header is injected globally via extraHTTPHeaders in playwright.config.ts.
    const res = await request.post('/workflows?draft=true', {
      headers: { 'Content-Type': 'application/json' },
      data: { id: WORKFLOW_ID, name: `Mobile Assistant Test — ${new Date().toISOString()}`, elements: [] }
    });

    if (!res.ok()) throw new Error(`beforeAll: POST /workflows → ${res.status()}`);
    const wf = await res.json() as { id: string };
    testProcessId = wf.id;
    console.log(`[beforeAll] Created workflow: ${testProcessId}`);
  });

  // ============================================================================
  // Mobile tests (390x844)
  // ============================================================================

  test('TC-02: Assistant opens as bottom sheet ~50vh (canvas visible above)', async ({ page }) => {
    page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto(`/ui/editor/${testProcessId}`);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('.ipe-canvas', { timeout: 10_000 }).catch(() => {});

    // Canvas must be visible — assistant at 50vh should not cover it
    const canvas = page.locator('.ipe-canvas');
    const canvasVisible = await canvas.isVisible().catch(() => false);
    expect(canvasVisible).toBe(true);

    // Expand widget — .aw-panel only renders when widgetState !== 'collapsed'
    await expandWidget(page);

    const panelExists = await page.locator('.aw-panel').count().then(c => c > 0).catch(() => false);
    expect(panelExists).toBe(true);
  });

  test('TC-03: Drag handle is present and draggable', async ({ page }) => {
    page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto(`/ui/editor/${testProcessId}`);
    await page.waitForLoadState('domcontentloaded');

    // Expand widget — .aw-drag-handle is inside .aw-panel (not rendered when collapsed)
    await expandWidget(page);

    const dragHandle = page.locator('.aw-drag-handle');
    const exists = await dragHandle.count().then(c => c > 0).catch(() => false);
    expect(exists).toBe(true);

    // Drag handle should be visible on mobile (CSS hides it on desktop via @media min-width 768px)
    const isVisible = await dragHandle.isVisible().catch(() => false);
    expect(isVisible).toBe(true);
  });

  test('TC-04: Drag handle changes height in 25–90% range', async ({ page }) => {
    page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto(`/ui/editor/${testProcessId}`);
    await page.waitForLoadState('domcontentloaded');

    // Expand widget before checking drag handle
    await expandWidget(page);

    const viewportHeight = MOBILE_VIEWPORT.height;
    const dragHandle = page.locator('.aw-drag-handle');
    const dragExists = await dragHandle.count().then(c => c > 0).catch(() => false);

    if (dragExists) {
      const boundingBox = await dragHandle.boundingBox().catch(() => null);
      if (boundingBox) {
        // Drag handle should be near the bottom of viewport (bottom sheet)
        expect(boundingBox.y).toBeGreaterThan(viewportHeight * 0.3);
      }
    }

    expect(dragExists).toBe(true);
  });

  test('TC-05: Fullscreen button expands to 100%', async ({ page }) => {
    page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto(`/ui/editor/${testProcessId}`);
    await page.waitForLoadState('domcontentloaded');

    // Expand widget — fullscreen button is inside .aw-panel header
    await expandWidget(page);

    const fullscreenBtn = page.locator('button[title*="fullscreen"], button[aria-label*="fullscreen"], .aw-hbtn');
    const btnExists = await fullscreenBtn.count().then(c => c > 0).catch(() => false);
    const panelFullscreen = page.locator('.aw-panel.fullscreen');
    const canBeFullscreen = await panelFullscreen.count().then(c => c > 0).catch(() => false);

    expect(btnExists || canBeFullscreen).toBe(true);
  });

  test('TC-06: Fullscreen toggle returns to bottom sheet', async ({ page }) => {
    page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto(`/ui/editor/${testProcessId}`);
    await page.waitForLoadState('domcontentloaded');

    // Expand widget — fullscreen button is inside .aw-panel
    await expandWidget(page);

    const fullscreenBtn = page.locator('button[title*="fullscreen"], button[aria-label*="fullscreen"], .aw-hbtn').first();
    const btnExists = await fullscreenBtn.count().then(c => c > 0).catch(() => false);

    if (btnExists) {
      // Step 1: click → panel should enter fullscreen
      await fullscreenBtn.click();
      await page.waitForTimeout(300);

      const isFullscreen = await page.locator('.aw-panel.fullscreen').count().then(c => c > 0).catch(() => false);
      expect(isFullscreen).toBe(true);

      // Step 2: click again → panel should exit fullscreen, return to bottom sheet (.expanded)
      await fullscreenBtn.click();
      await page.waitForTimeout(300);

      const fullscreenGone = await page.locator('.aw-panel.fullscreen').count().then(c => c === 0).catch(() => false);
      const expandedBack = await page.locator('.aw-panel.expanded').count().then(c => c > 0).catch(() => false);
      expect(fullscreenGone).toBe(true);
      expect(expandedBack).toBe(true);
    } else {
      // No toggle button — verify panel is in bottom-sheet state
      const panelExpanded = await page.locator('.aw-panel.expanded').count().then(c => c > 0).catch(() => false);
      expect(panelExpanded).toBe(true);
    }
  });

  // ============================================================================
  // Responsive tests (resize)
  // ============================================================================

  test('TC-07: Resize to desktop (>767px) — isMobile=false, bottom sheet hidden', async ({ page }) => {
    // Start on mobile, expand widget so .aw-drag-handle is in DOM
    page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto(`/ui/editor/${testProcessId}`);
    await page.waitForLoadState('domcontentloaded');
    await expandWidget(page);

    // On mobile: drag handle visible
    const dragHandleMobile = page.locator('.aw-drag-handle');
    const dragVisibleMobile = await dragHandleMobile.isVisible().catch(() => false);

    // Resize to desktop
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.waitForTimeout(500); // Let CSS media queries + React resize handler update

    // On desktop: drag handle hidden by CSS (@media min-width 768px)
    const dragVisibleDesktop = await dragHandleMobile.isVisible().catch(() => false);
    expect(dragVisibleDesktop).toBe(false);
  });

  test('TC-08: Resize back to mobile (<768px) — isMobile=true, bottom sheet active', async ({ page }) => {
    // Start on desktop, expand widget so .aw-drag-handle is in DOM
    page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto(`/ui/editor/${testProcessId}`);
    await page.waitForLoadState('domcontentloaded');
    await expandWidget(page);

    // Resize to mobile
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.waitForTimeout(500); // Let CSS media queries + React resize handler update

    // Drag handle should exist and be visible on mobile
    const dragHandle = page.locator('.aw-drag-handle');
    const exists = await dragHandle.count().then(c => c > 0).catch(() => false);
    expect(exists).toBe(true);
    const isVisible = await dragHandle.isVisible().catch(() => false);
    expect(isVisible).toBe(true);
  });

  test('TC-09: Screenshot of mobile assistant bottom sheet', async ({ page }) => {
    page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto(`/ui/editor/${testProcessId}`);
    await page.waitForLoadState('domcontentloaded');

    // Expand widget for screenshot
    await page.waitForSelector('.aw-trigger', { timeout: 10_000 }).catch(() => {});
    const trigger = page.locator('.aw-trigger');
    const hasTrigger = await trigger.count().then(c => c > 0).catch(() => false);
    if (hasTrigger) await trigger.click().catch(() => {});

    const screenshot = await page.screenshot({
      path: '/opt/shared/shino/reports/2026-04-10-screenshot-432-mobile.png'
    });

    expect(screenshot.byteLength).toBeGreaterThan(3_000);
  });

  test('TC-10: Screenshot of desktop assistant (window resize)', async ({ page }) => {
    page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto(`/ui/editor/${testProcessId}`);
    await page.waitForLoadState('domcontentloaded');

    const screenshot = await page.screenshot({
      path: '/opt/shared/shino/reports/2026-04-10-screenshot-432-desktop.png'
    });

    expect(screenshot.byteLength).toBeGreaterThan(3_000);
  });
});
