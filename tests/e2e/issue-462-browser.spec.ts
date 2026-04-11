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

    // Wait for React to mount and render (domcontentloaded fires before JS executes)
    await page.waitForLoadState('networkidle');

    // Verify cases page loaded (not redirect)
    expect(page.url()).toContain('/ui/cases');
    expect(page.url()).not.toContain('/ui/login');

    // Verify React rendered meaningful content (SPA shell alone is ~400 bytes)
    const content = await page.content();
    expect(content).toBeTruthy();
    expect(content.length).toBeGreaterThan(1000);

    // Take screenshot
    await page.screenshot({ path: '/opt/shared/shino/reports/2026-04-11-tc-b02-cases.png' });
  });

  test('TC-B03: Connector event case auto-advanced', async ({ page, request }) => {
    // Register a minimal workflow: start event → function (draft skips AI trigger resolution)
    const wfResp = await request.post('/workflows?draft=true', {
      data: {
        id: 'tc-b03-connector-462',
        name: 'TC-B03 Connector Event Test',
        version: '1.0.0',
        elements: [
          { id: 'e1', type: 'event',    label: 'Request Received' },
          { id: 'f1', type: 'function', label: 'Handle Request', role: 'tester' },
          { id: 'e2', type: 'event',    label: 'Done' },
        ],
        flow: [['e1', 'f1'], ['f1', 'e2']],
      },
    });
    expect(wfResp.status()).toBe(201);

    // Create a case — the start event (e1) must auto-advance immediately
    const caseResp = await request.post('/cases', {
      data: {
        process_id: 'tc-b03-connector-462',
        subject: 'TC-B03 connector event auto-advance',
      },
    });
    expect(caseResp.status()).toBe(201);

    const kase = await caseResp.json();
    // Connector event auto-advanced: case must be running (not done/error)
    expect(kase.status).toBe('running');
    // Position must be at the first function node, not the start event itself
    expect(kase.position).toBe('f1');
    // Start event (e1) must appear in history — it was visited before advancing
    const histIds = kase.history.map((h: { element_id: string }) => h.element_id);
    expect(histIds).toContain('e1');

    // Verify the case appears in the browser UI
    await page.goto('/ui/cases');
    await page.waitForLoadState('domcontentloaded');
    expect(page.url()).toContain('/ui/cases');
    expect(page.url()).not.toContain('/ui/login');

    await page.screenshot({ path: '/opt/shared/shino/reports/2026-04-11-tc-b03-connector.png' });
  });

  test('TC-B04: XOR gateway shows correct branch', async ({ page, request }) => {
    // Register a workflow with XOR gateway (draft skips AI trigger resolution)
    const wfResp = await request.post('/workflows?draft=true', {
      data: {
        id: 'tc-b04-xor-gateway-462',
        name: 'TC-B04 XOR Gateway Test',
        version: '1.0.0',
        elements: [
          { id: 'e1', type: 'event',    label: 'Start' },
          { id: 'f1', type: 'function', label: 'Prepare', role: 'tester' },
          { id: 'e2', type: 'event',    label: 'Prepared' },
          { id: 'g1', type: 'gateway',  label: 'Route', operator: 'XOR' },
          { id: 'f2', type: 'function', label: 'Path A', role: 'tester' },
          { id: 'f3', type: 'function', label: 'Path B', role: 'tester' },
          { id: 'e3', type: 'event',    label: 'Done A' },
          { id: 'e4', type: 'event',    label: 'Done B' },
        ],
        flow: [
          ['e1', 'f1'],
          ['f1', 'e2'],
          ['e2', 'g1'],
          ["g1", "f2", "payload.path === 'a'"],
          ["g1", "f3", "payload.path === 'b'"],
          ['f2', 'e3'],
          ['f3', 'e4'],
        ],
      },
    });
    expect(wfResp.status()).toBe(201);

    // Create case with payload routing to Path A
    const caseResp = await request.post('/cases', {
      data: {
        process_id: 'tc-b04-xor-gateway-462',
        subject: 'TC-B04 XOR path-a test',
        payload: { path: 'a' },
      },
    });
    expect(caseResp.status()).toBe(201);

    const kase = await caseResp.json();
    expect(kase.status).toBe('running');
    // After start event auto-advance, case should be at f1
    expect(kase.position).toBe('f1');

    // Find the work item for f1 from case history
    const f1Entry = kase.history.find((h: { element_id: string }) => h.element_id === 'f1');
    expect(f1Entry).toBeDefined();
    expect(f1Entry.work_item_id).toBeDefined();

    // Complete f1 — XOR gateway evaluates payload.path === 'a' → must route to f2
    const completeResp = await request.post(`/workitems/${f1Entry.work_item_id}/complete`, {
      data: { output: {} },
    });
    expect(completeResp.status()).toBe(200);

    const result = await completeResp.json();
    const updated = result.case;
    expect(updated).toBeDefined();
    // XOR branched correctly to Path A (f2), not Path B (f3)
    expect(updated.position).toBe('f2');
    const updatedHistIds = updated.history.map((h: { element_id: string }) => h.element_id);
    expect(updatedHistIds).toContain('f2');
    expect(updatedHistIds).not.toContain('f3');

    // Verify the case detail page loads in the browser
    await page.goto(`/ui/cases/${kase.case_id}`);
    await page.waitForLoadState('domcontentloaded');
    expect(page.url()).toContain(`/ui/cases/${kase.case_id}`);
    expect(page.url()).not.toContain('/ui/login');

    await page.screenshot({ path: '/opt/shared/shino/reports/2026-04-11-tc-b04-xor.png' });
  });
});
