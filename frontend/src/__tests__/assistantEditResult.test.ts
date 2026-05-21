import { describe, expect, test } from 'vitest';
import { schemaPatchDurability } from '../hooks/useAssistantChat';

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
});
