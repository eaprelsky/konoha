import { describe, expect, test } from 'vitest';
import { buildProcessEditorOperatorState, OPERATOR_STATE_VERSION } from '../operatorState';

describe('operatorState', () => {
  test('builds canonical process-editor operator state', () => {
    window.history.replaceState({}, '', '/ui/editor/order-flow?mode=test');
    Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 720, configurable: true });
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });

    const state = buildProcessEditorOperatorState({
      readOnly: false,
      wfId: 'order-flow',
      wfName: 'Order Flow',
      isKnown: true,
      elements: [
        { id: 'e1', type: 'event', label: 'Start' },
        { id: 'f1', type: 'function', label: 'Check order', role: 'Manager', intent: 'Validate order' },
      ],
      positions: {
        e1: { x: 40, y: 40 },
        f1: { x: 40, y: 180 },
      },
      flow: [['e1', 'f1']],
      selected: 'f1',
      multiSelected: ['f1', 'e1'],
      hoveredEl: 'f1',
      connectFrom: null,
      editingId: null,
      gatewayPickerId: null,
      mode: 'select',
      breadcrumb: [{ id: 'root', name: 'Root' }],
      viewingVersion: '1.0.0',
      panX: 12,
      panY: 24,
      zoom: 1.25,
      saving: false,
      autosavePending: true,
      draftWarning: { text: 'Draft only', details: ['missing end event'] },
      triggerResolving: new Set(['e1']),
      undoDepth: 2,
      redoDepth: 1,
      roles: [{ role_id: 'manager', name: 'Manager', assignees: [], strategy: 'manual', created_at: '', updated_at: '' }],
      docs: [],
      adapters: ['telegram'],
      lifecycleState: 'executable',
    });

    expect(state.version).toBe(OPERATOR_STATE_VERSION);
    expect(state.current_view.route).toContain('/ui/editor/order-flow');
    expect(state.current_process?.workflow.id).toBe('order-flow');
    expect(state.current_process?.workflow.lifecycle_state).toBe('executable');
    expect(state.current_process?.workflow.runnable).toBe(true);
    expect(state.current_process?.workflow.element_count).toBe(2);
    expect(state.current_process?.selection.selected_ids).toEqual(['f1', 'e1']);
    expect(state.current_process?.pending.trigger_resolving_ids).toEqual(['e1']);
    expect(state.current_process?.changes.has_local_changes).toBe(true);
    expect(state.current_process?.affordances.can_save).toBe(true);
    expect(state.current_process?.affordances.actions.some((action) => action.action_id === 'workflow.update' && action.availability === 'available')).toBe(true);
    expect(state.current_process?.affordances.actions.some((action) => action.action_id === 'case.start' && action.availability === 'available')).toBe(true);
    expect(state.current_process?.affordances.actions.some((action) => action.action_id === 'trigger.set' && action.availability === 'unavailable')).toBe(true);
    expect(state.current_process?.affordances.actions.find((action) => action.action_id === 'element.update')?.suggested_args).toEqual({
      workflow_id: 'order-flow',
      id: 'f1',
    });
    expect(state.current_process?.workflow.elements[1]?.position).toEqual({ x: 40, y: 180 });
  });

  test('blocks case.start affordance for non-executable lifecycle states', () => {
    const state = buildProcessEditorOperatorState({
      readOnly: false,
      wfId: 'draft-flow',
      wfName: 'Draft Flow',
      isKnown: true,
      elements: [{ id: 'e1', type: 'event', label: 'Start' }],
      positions: { e1: { x: 40, y: 40 } },
      flow: [],
      selected: null,
      multiSelected: [],
      hoveredEl: null,
      connectFrom: null,
      editingId: null,
      gatewayPickerId: null,
      mode: 'select',
      breadcrumb: [],
      viewingVersion: null,
      panX: 0,
      panY: 0,
      zoom: 1,
      saving: false,
      autosavePending: false,
      draftWarning: null,
      triggerResolving: new Set(),
      undoDepth: 0,
      redoDepth: 0,
      roles: [],
      docs: [],
      adapters: [],
      lifecycleState: 'validated',
    });

    const start = state.current_process?.affordances.actions.find((action) => action.action_id === 'case.start');
    expect(state.current_process?.workflow.lifecycle_state).toBe('validated');
    expect(state.current_process?.workflow.runnable).toBe(false);
    expect(start?.availability).toBe('unavailable');
    expect(start?.reason).toContain('WORKFLOW_NOT_EXECUTABLE');
  });
});
