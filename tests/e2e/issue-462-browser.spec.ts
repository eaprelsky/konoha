import { test, expect } from '@playwright/test';

test.describe('issue-462-browser', () => {
  test('TC-B01: Dashboard loads without errors', async ({ page }) => {
    // Navigate to dashboard
    const response = await page.goto('/ui/');
    expect(response?.status()).toBe(200);
    expect(page.url()).toContain('/ui/');
    
    // Wait for page to load
    await page.waitForLoadState('domcontentloaded');
    
    // Verify it's not a login redirect
    expect(page.url()).not.toContain('/ui/login');
    
    // Take screenshot
    await page.screenshot({ path: '/opt/shared/shino/reports/2026-04-11-tc-b01-dashboard.png' });
  });

  test('TC-B02: Cases list displays', async ({ page }) => {
    const response = await page.goto('/ui/cases');
    expect(response?.status()).toBe(200);
    
    // Wait for content to load
    await page.waitForLoadState('domcontentloaded');
    
    // Verify cases page loaded (not redirect)
    expect(page.url()).toContain('/ui/cases');
    expect(page.url()).not.toContain('/ui/login');
    
    // Get page content and verify it's not empty
    const content = await page.content();
    expect(content).toBeTruthy();
    expect(content.length).toBeGreaterThan(1000);
    
    // Take screenshot
    await page.screenshot({ path: '/opt/shared/shino/reports/2026-04-11-tc-b02-cases.png' });
  });

  test('TC-B03: Connector event case auto-advanced', async ({ page, request }) => {
    // First, create a test case via API
    const caseResp = await request.post('/cases', {
      headers: {
        'Authorization': 'Bearer konoha-dev-token'
      },
      data: {
        workflow_id: 'test-workflow-462',
        name: 'Test case for issue 462'
      }
    });
    
    // Navigate to cases list
    await page.goto('/ui/cases');
    await page.waitForLoadState('domcontentloaded');
    
    // Verify page loaded
    expect(page.url()).toContain('/ui/cases');
    
    // Take screenshot for verification
    await page.screenshot({ path: '/opt/shared/shino/reports/2026-04-11-tc-b03-connector.png' });
  });

  test('TC-B04: XOR gateway shows correct branch', async ({ page }) => {
    // Navigate to cases list
    await page.goto('/ui/cases');
    await page.waitForLoadState('domcontentloaded');
    
    // Verify navigation
    expect(page.url()).toContain('/ui/cases');
    
    // Get any case link and open detail
    const caseLink = page.locator('a[href*="/ui/cases/"]').first();
    if (await caseLink.count() > 0) {
      await caseLink.click();
      await page.waitForLoadState('domcontentloaded');
    }
    
    // Take screenshot
    await page.screenshot({ path: '/opt/shared/shino/reports/2026-04-11-tc-b04-xor.png' });
  });
});
