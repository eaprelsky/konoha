import { test, expect } from '@playwright/test';

test.describe('Workflow assistant canonical contract', () => {
  test('AssistantWidget applies canonical /api/ai/chat parsed schema patch', async ({ page, request }) => {
    const workflowId = `e2e-assistant-contract-${Date.now()}`;
    const created = await request.post('/workflows?draft=true', {
      data: {
        id: workflowId,
        name: 'E2E Assistant Contract',
        version: '1.0.0',
        elements: [{ id: 'e1', type: 'event', label: 'Start', x: 120, y: 120 }],
        flow: [],
      },
    });
    expect(created.status()).toBe(201);

    await page.route('**/api/ai/chat', async route => {
      const parsedEvent = {
        type: 'parsed',
        reply: 'Добавила шаг проверки.',
        schema_patch: {
          add_elements: [{ id: 'f_added', type: 'function', label: 'Проверить заявку', x: 120, y: 260 }],
        },
        created_workflow: null,
        actions: [],
        actions_taken: [],
        pending_confirmations: [],
        action_receipts: [{
          id: 'receipt-e2e',
          action: 'workflow.update',
          status: 'succeeded',
          summary: 'Подготовлено изменение схемы: 1 объект(ов) затронуто.',
          changed_resources: [{ kind: 'element', id: 'f_added', label: 'Проверить заявку', change: 'created' }],
          audit: { session_id: 'e2e', action_type: 'workflow.update' },
        }],
        observable_result: {
          status: 'succeeded',
          summary: 'Подготовлено изменение схемы: 1 объект(ов) затронуто.',
          receipts: [],
          counts: { succeeded: 1, pending_confirmation: 0, failed: 0, partial: 0 },
        },
      };

      await route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'X-Chat-Id': 'e2e-assistant-contract-chat',
        },
        body: [
          'data: {"type":"chat_id","chat_id":"e2e-assistant-contract-chat"}',
          '',
          `data: ${JSON.stringify(parsedEvent)}`,
          '',
          'data: [DONE]',
          '',
        ].join('\n'),
      });
    });

    await page.goto(`/ui/editor/${workflowId}`);
    await expect(page.locator('.ipe-canvas')).toBeVisible({ timeout: 10_000 });
    await expect.poll(async () =>
      page.evaluate(() => typeof (window as any).__konoha_apply_schema_patch)
    ).toBe('function');
    await page.evaluate(() => {
      (window as any).__workflowAssistantPatches = [];
      window.addEventListener('konoha:schema_patch', (event: Event) => {
        (window as any).__workflowAssistantPatches.push((event as CustomEvent).detail);
      });
    });

    await page.locator('.aw-trigger').click();
    await page.locator('.aw-input').fill('Добавь шаг проверки');
    await page.locator('.aw-send').click();

    await expect(page.locator('.aw-msg.assistant', { hasText: 'Добавила шаг проверки.' })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.aw-msg.system', { hasText: 'Схема обновлена' })).toBeVisible({ timeout: 10_000 });
    await expect.poll(async () =>
      page.evaluate(() => (window as any).__workflowAssistantPatches?.length ?? 0)
    ).toBeGreaterThan(0);
    await expect.poll(async () =>
      page.locator('.ipe-canvas svg').last().evaluate(svg => svg.innerHTML)
    ).toContain('Проверить заявку');
  });
});
