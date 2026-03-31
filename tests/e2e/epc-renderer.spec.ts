/**
 * E2E tests for eEPC renderer case-state highlighting (TC-11–TC-16).
 * Loads /ui/processes.html (which includes epc-renderer.js), injects a
 * temporary container, calls EpcRenderer.renderProcess() with a minimal
 * process + case object, then asserts SVG shape attributes.
 */
import { test, expect } from '@playwright/test';

// Minimal valid process definition with a single function node 'n1'
const MINIMAL_DEF = {
  elements: [{ id: 'n1', type: 'function', label: 'Test Node', role: 'test' }],
  flow: [],
};

/** Returns the primary shape attributes for node n1 rendered inside a temp container. */
async function getNodeAttrs(page: any, caseData: any): Promise<Record<string, string | null>> {
  return page.evaluate(([def, caseObj]: [any, any]) => { // def = MINIMAL_DEF, serialized from Node scope
    const container = document.createElement('div');
    container.id = 'test-epc-container';
    document.body.appendChild(container);
    try {
      (window as any).EpcRenderer.renderProcess(def, container, { case: caseObj });
      // The node group has data-node-id='n1'; primary shape is first child rect/polygon/circle/ellipse
      const g = container.querySelector('[data-node-id="n1"]');
      if (!g) return { error: 'node group not found' };
      const shape = g.querySelector('rect, polygon, circle, ellipse') as SVGElement | null;
      if (!shape) return { error: 'shape not found' };
      return {
        stroke: shape.getAttribute('stroke'),
        strokeWidth: shape.getAttribute('stroke-width'),
        fill: shape.getAttribute('fill'),
        opacity: shape.getAttribute('opacity'),
        strokeDasharray: shape.getAttribute('stroke-dasharray'),
        className: shape.getAttribute('class') || '',
      };
    } finally {
      container.remove();
    }
  }, [MINIMAL_DEF, caseData]);
}

test.describe('eEPC renderer — case highlighting (TC-11–TC-16)', () => {
  test.beforeEach(async ({ page }) => {
    // Load the page that includes epc-renderer.js and wait for renderer to be available
    await page.goto('/ui/processes.html');
    await page.waitForFunction(() => typeof (window as any).EpcRenderer !== 'undefined', { timeout: 10000 });
  });

  test('TC-11: completed → green border, full opacity', async ({ page }) => {
    const caseData = { history: [{ node_id: 'n1', status: 'completed' }], position: null };
    const attrs = await getNodeAttrs(page, caseData);

    expect(attrs.stroke).toBe('#22c55e');
    expect(attrs.strokeWidth).toBe('2');
    // opacity attribute should not be set (defaults to 1.0)
    expect(attrs.opacity).toBeNull();
    // no animation class
    expect(attrs.className).not.toContain('epc-running');
    expect(attrs.className).not.toContain('epc-error');
  });

  test('TC-12: running → amber border + epc-running animation class', async ({ page }) => {
    const caseData = { history: [], position: 'n1' };
    const attrs = await getNodeAttrs(page, caseData);

    expect(attrs.stroke).toBe('#f59e0b');
    expect(attrs.strokeWidth).toBe('3');
    expect(attrs.className).toContain('epc-running');
    expect(attrs.opacity).toBeNull();
  });

  test('TC-13: waiting → grey fill + dashed border', async ({ page }) => {
    const caseData = { history: [{ node_id: 'n1', status: 'waiting' }], position: null };
    const attrs = await getNodeAttrs(page, caseData);

    expect(attrs.fill).toBe('#d1d5db');
    expect(attrs.stroke).toBe('#9ca3af');
    expect(attrs.strokeDasharray).toBe('5 3');
  });

  test('TC-14: error → red border + epc-error animation class', async ({ page }) => {
    const caseData = { history: [{ node_id: 'n1', status: 'error' }], position: null };
    const attrs = await getNodeAttrs(page, caseData);

    expect(attrs.stroke).toBe('#ef4444');
    expect(attrs.strokeWidth).toBe('3');
    expect(attrs.className).toContain('epc-error');

    // Error icon (⚠) should be rendered as a text element inside the group
    const hasErrorIcon = await page.evaluate(([def, caseObj]: [any, any]) => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      try {
        (window as any).EpcRenderer.renderProcess(def, container, { case: caseObj });
        const g = container.querySelector('[data-node-id="n1"]');
        const texts = Array.from(g?.querySelectorAll('text') || []) as SVGTextElement[];
        return texts.some(t => t.textContent?.includes('⚠'));
      } finally {
        container.remove();
      }
    }, [MINIMAL_DEF, caseData]);
    expect(hasErrorIcon).toBe(true);
  });

  test('TC-15: not_reached → semi-transparent (opacity 0.4)', async ({ page }) => {
    const caseData = { history: [{ node_id: 'n1', status: 'not_reached' }], position: null };
    const attrs = await getNodeAttrs(page, caseData);

    expect(attrs.opacity).toBe('0.4');
    // No status stroke override — default function stroke preserved
    expect(attrs.stroke).toBe('#3B6D11');
    // No animation classes
    expect(attrs.className).toBe('');
  });

  test('TC-16: node not in case history → DEFAULT_STYLE (no status overrides)', async ({ page }) => {
    // 'n1' is NOT in history and NOT in position → receives DEFAULT_STYLE
    const caseData = { history: [{ node_id: 'other', status: 'completed' }], position: null };
    const attrs = await getNodeAttrs(page, caseData);

    // Default function stroke is #3B6D11 (set by renderFunction, not overridden by DEFAULT_STYLE)
    expect(attrs.stroke).toBe('#3B6D11');
    // No status-driven opacity or dash override
    expect(attrs.opacity).toBeNull();
    expect(attrs.strokeDasharray).toBeNull();
    expect(attrs.className).toBe('');
  });
});
