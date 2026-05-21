import { describe, expect, test } from 'vitest';
import { schemaPatchDurability } from '../hooks/useAssistantChat';
import { schemaPatchPanelDecision } from '../pages/TsunadeChatPanel';

describe('assistant edit result contract', () => {
  test.each([
    ['committed', 'saved'],
    ['pending_confirmation', 'pending'],
    ['failed', 'failed'],
    ['preview', 'preview'],
  ])('maps %s edit mode without inferring from receipts', (mode, expected) => {
    expect(schemaPatchDurability({
      edit_result: { kind: 'schema_patch', mode, durable: mode === 'committed', action: 'workflow.patch', summary: mode },
      action_receipts: [{ action: 'workflow.patch', status: 'succeeded' }],
    })).toBe(expected);
  });

  test('defaults missing edit_result to preview for legacy parsed events', () => {
    expect(schemaPatchDurability({
      action_receipts: [{ action: 'workflow.patch', status: 'succeeded' }],
    })).toBe('preview');
  });

  test('TsunadeChatPanel renders edit_result mode for flow-only schema patches', () => {
    const flowOnlyPatch = { add_flow: [['start', 'done']] as [string, string][] };

    expect(schemaPatchPanelDecision(flowOnlyPatch, 'preview')).toEqual({
      apply: true,
      text: 'Предпросмотр схемы применён локально. Нажмите 💾 для сохранения.',
    });
    expect(schemaPatchPanelDecision(flowOnlyPatch, 'committed')).toEqual({
      apply: true,
      text: 'Схема сохранена на сервере.',
    });
  });

  test('TsunadeChatPanel does not apply failed or pending flow-only schema patches', () => {
    const flowOnlyPatch = { remove_flow: [['start', 'done']] as [string, string][] };

    expect(schemaPatchPanelDecision(flowOnlyPatch, 'pending_confirmation')).toEqual({
      apply: false,
      text: 'Изменение подготовлено и ждёт подтверждения.',
    });
    expect(schemaPatchPanelDecision(flowOnlyPatch, 'failed')).toEqual({
      apply: false,
      text: 'Изменение отклонено серверной проверкой. Холст не изменён.',
    });
  });
});
