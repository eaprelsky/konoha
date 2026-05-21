import { describe, expect, test } from 'vitest';
import { canonicalWorkflowLifecycleState, workflowLifecycleView } from '../workflowLifecycle';

describe('workflow lifecycle UI contract', () => {
  test('uses canonical lifecycle_state from backend contracts', () => {
    expect(canonicalWorkflowLifecycleState({ lifecycle_state: 'validated', status: 'executable' })).toBe('validated');
    expect(canonicalWorkflowLifecycleState({ status: 'retired' })).toBe('retired');
    expect(canonicalWorkflowLifecycleState({ status: 'active' })).toBe('draft');
  });

  test('allows run controls only for executable workflows', () => {
    expect(workflowLifecycleView({ lifecycle_state: 'executable' }).canStartCase).toBe(true);

    for (const state of ['draft', 'validated', 'deployed', 'retired'] as const) {
      const view = workflowLifecycleView({ lifecycle_state: state });
      expect(view.canStartCase).toBe(false);
      expect(view.runBlockedReason).toContain('WORKFLOW_NOT_EXECUTABLE');
    }
  });
});
