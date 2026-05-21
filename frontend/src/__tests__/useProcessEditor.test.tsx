/**
 * useProcessEditor unit tests — issue #336
 * Tests: initial state, addElement, deleteElement, updateElement,
 *        removeEdge, undo/redo, newProcess, paletteClick, loadWorkflow
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { api } from '../api/client';
import { useProcessEditor } from '../pages/useProcessEditor';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../api/client', () => ({
  api: {
    workflows: {
      list: vi.fn().mockResolvedValue([
        { id: 'proc-1', name: 'Test Process', elements: [{ id: 'event-1', type: 'event', label: 'Start' }], flow: [], version: '1.0.0' },
      ]),
      getFresh: vi.fn().mockResolvedValue({ id: 'proc-1', name: 'Test Process', elements: [{ id: 'event-1', type: 'event', label: 'Start' }], flow: [], version: '1.0.0' }),
      validate: vi.fn().mockResolvedValue({
        workflow_id: 'proc-1',
        taxonomy_version: 1,
        readiness: 'ready',
        source: 'workflow.deploy',
        errors: [],
        warnings: [],
        checked_at: '2026-05-21T00:00:00.000Z',
        gates: {
          deployment_blocker: false,
          case_start_blocker: false,
          release_blocker: false,
          reviewer_required: false,
        },
      }),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
      versions: vi.fn().mockResolvedValue([]),
    },
    roles: { list: vi.fn().mockResolvedValue([]), create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
    agents: { list: vi.fn().mockResolvedValue([]) },
    people: { list: vi.fn().mockResolvedValue([]) },
    documents: { list: vi.fn().mockResolvedValue([]) },
    adapters: { list: vi.fn().mockResolvedValue({ adapters: [] }) },
    workspace: { list: vi.fn().mockResolvedValue([]) },
    mining: { process: vi.fn().mockResolvedValue(null) },
  },
}));

vi.mock('../context/TokenContext', () => ({
  useToken: () => 'test-token',
}));

// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  (api.workflows.list as any).mockResolvedValue([
    { id: 'proc-1', name: 'Test Process', elements: [{ id: 'event-1', type: 'event', label: 'Start' }], flow: [], version: '1.0.0' },
  ]);
  (api.workflows.getFresh as any).mockResolvedValue({
    id: 'proc-1',
    name: 'Test Process',
    elements: [{ id: 'event-1', type: 'event', label: 'Start' }],
    flow: [],
    version: '1.0.0',
  });
});

describe('useProcessEditor — initial state', () => {
  it('starts with empty elements, flow and positions', () => {
    const { result } = renderHook(() => useProcessEditor());
    expect(result.current.elements).toEqual([]);
    expect(result.current.flow).toEqual([]);
    expect(result.current.positions).toEqual({});
  });

  it('starts with mode = select', () => {
    const { result } = renderHook(() => useProcessEditor());
    expect(result.current.mode).toBe('select');
  });

  it('starts with no selected element', () => {
    const { result } = renderHook(() => useProcessEditor());
    expect(result.current.selected).toBeNull();
  });
});

describe('useProcessEditor — addElement', () => {
  it('adds an element to elements array', () => {
    const { result } = renderHook(() => useProcessEditor());
    act(() => { result.current.addElement('function'); });
    expect(result.current.elements).toHaveLength(1);
    expect(result.current.elements[0].type).toBe('function');
  });

  it('generates sequential IDs for same type', () => {
    const { result } = renderHook(() => useProcessEditor());
    act(() => { result.current.addElement('function'); });
    act(() => { result.current.addElement('function'); });
    expect(result.current.elements[0].id).toBe('function-1');
    expect(result.current.elements[1].id).toBe('function-2');
  });

  it('gateway element gets operator = AND by default', () => {
    const { result } = renderHook(() => useProcessEditor());
    act(() => { result.current.addElement('gateway'); });
    expect(result.current.elements[0].operator).toBe('AND');
  });

  it('sets position for added element', () => {
    const { result } = renderHook(() => useProcessEditor());
    act(() => { result.current.addElement('event'); });
    const id = result.current.elements[0].id;
    expect(result.current.positions[id]).toBeDefined();
    expect(typeof result.current.positions[id].x).toBe('number');
    expect(typeof result.current.positions[id].y).toBe('number');
  });

  it('selects the newly added element', () => {
    const { result } = renderHook(() => useProcessEditor());
    act(() => { result.current.addElement('function'); });
    const id = result.current.elements[0].id;
    expect(result.current.selected).toBe(id);
  });

  it('uses provided label instead of default', () => {
    const { result } = renderHook(() => useProcessEditor());
    act(() => { result.current.addElement('function', 'My Custom Label'); });
    expect(result.current.elements[0].label).toBe('My Custom Label');
  });
});

describe('useProcessEditor — deleteElement', () => {
  it('removes element from array', () => {
    const { result } = renderHook(() => useProcessEditor());
    act(() => { result.current.addElement('function'); });
    const id = result.current.elements[0].id;
    act(() => { result.current.deleteElement(id); });
    expect(result.current.elements).toHaveLength(0);
  });

  it('removes flow edges connected to deleted element', () => {
    const { result } = renderHook(() => useProcessEditor());
    act(() => { result.current.addElement('event'); });
    act(() => { result.current.addElement('function'); });
    const evId = result.current.elements[0].id;
    const fnId = result.current.elements[1].id;
    act(() => {
      result.current.setFlow([[evId, fnId]]);
    });
    act(() => { result.current.deleteElement(evId); });
    expect(result.current.flow.some(([f, t]) => f === evId || t === evId)).toBe(false);
  });

  it('does not remove a locked element', () => {
    const { result } = renderHook(() => useProcessEditor());
    act(() => { result.current.addElement('event'); });
    const id = result.current.elements[0].id;
    act(() => { result.current.updateElement(id, { locked: true }); });
    act(() => { result.current.deleteElement(id); });
    expect(result.current.elements).toHaveLength(1);
  });

  it('clears selection when selected element is deleted', () => {
    const { result } = renderHook(() => useProcessEditor());
    act(() => { result.current.addElement('function'); });
    const id = result.current.elements[0].id;
    expect(result.current.selected).toBe(id);
    act(() => { result.current.deleteElement(id); });
    expect(result.current.selected).toBeNull();
  });
});

describe('useProcessEditor — updateElement', () => {
  it('patches element label', () => {
    const { result } = renderHook(() => useProcessEditor());
    act(() => { result.current.addElement('function'); });
    const id = result.current.elements[0].id;
    act(() => { result.current.updateElement(id, { label: 'Updated Label' }); });
    const el = result.current.elements.find(e => e.id === id);
    expect(el?.label).toBe('Updated Label');
  });

  it('preserves other element fields when patching', () => {
    const { result } = renderHook(() => useProcessEditor());
    act(() => { result.current.addElement('function'); });
    const id = result.current.elements[0].id;
    act(() => { result.current.updateElement(id, { role: 'Developer' }); });
    const el = result.current.elements.find(e => e.id === id);
    expect(el?.type).toBe('function');
    expect(el?.role).toBe('Developer');
  });
});

describe('useProcessEditor — removeEdge', () => {
  it('removes specific edge from flow', () => {
    const { result } = renderHook(() => useProcessEditor());
    act(() => { result.current.addElement('event'); });
    act(() => { result.current.addElement('function'); });
    const [evId, fnId] = result.current.elements.map(e => e.id);
    act(() => { result.current.setFlow([[evId, fnId]]); });
    act(() => { result.current.removeEdge(evId, fnId); });
    expect(result.current.flow).toHaveLength(0);
  });

  it('only removes the targeted edge, keeping others', () => {
    const { result } = renderHook(() => useProcessEditor());
    act(() => { result.current.addElement('event'); });
    act(() => { result.current.addElement('function'); });
    act(() => { result.current.addElement('event'); });
    const [ev1, fn1, ev2] = result.current.elements.map(e => e.id);
    act(() => { result.current.setFlow([[ev1, fn1], [ev2, fn1]]); });
    act(() => { result.current.removeEdge(ev1, fn1); });
    expect(result.current.flow).toHaveLength(1);
    expect(result.current.flow[0]).toEqual([ev2, fn1]);
  });
});

describe('useProcessEditor — undo / redo', () => {
  it('undo restores previous elements state', () => {
    const { result } = renderHook(() => useProcessEditor());
    act(() => { result.current.addElement('function'); });
    expect(result.current.elements).toHaveLength(1);
    act(() => { result.current.undo(); });
    expect(result.current.elements).toHaveLength(0);
  });

  it('redo reapplies undone change', () => {
    const { result } = renderHook(() => useProcessEditor());
    act(() => { result.current.addElement('function'); });
    act(() => { result.current.undo(); });
    expect(result.current.elements).toHaveLength(0);
    act(() => { result.current.redo(); });
    expect(result.current.elements).toHaveLength(1);
  });

  it('undo does nothing when stack is empty', () => {
    const { result } = renderHook(() => useProcessEditor());
    act(() => { result.current.undo(); });
    expect(result.current.elements).toHaveLength(0);
  });

  it('addElement pushes snapshot so undo is possible', () => {
    const { result } = renderHook(() => useProcessEditor());
    act(() => { result.current.addElement('event'); });
    act(() => { result.current.addElement('function'); });
    act(() => { result.current.undo(); });
    expect(result.current.elements).toHaveLength(1);
    expect(result.current.elements[0].type).toBe('event');
  });
});

describe('useProcessEditor — newProcess', () => {
  it('clears elements, flow and positions', () => {
    const { result } = renderHook(() => useProcessEditor());
    act(() => { result.current.addElement('function'); });
    act(() => { result.current.newProcess(); });
    expect(result.current.elements).toHaveLength(0);
    expect(result.current.flow).toHaveLength(0);
    expect(result.current.positions).toEqual({});
  });

  it('resets wfId and wfName', () => {
    const { result } = renderHook(() => useProcessEditor());
    act(() => { result.current.newProcess(); });
    expect(result.current.wfId).toBe('');
    expect(result.current.wfName).toBe('');
  });
});

describe('useProcessEditor — paletteClick', () => {
  it('adds element directly when no registry entries exist', () => {
    const { result } = renderHook(() => useProcessEditor());
    // roles/docs/adapters are empty (mocked as []), so no picker opens
    act(() => { result.current.paletteClick('function'); });
    expect(result.current.elements).toHaveLength(1);
    expect(result.current.picker).toBeNull();
  });
});

describe('useProcessEditor — assistant schema patch reconciliation', () => {
  async function loadDefaultWorkflow() {
    const rendered = renderHook(() => useProcessEditor());
    await waitFor(() => expect(rendered.result.current.workflows).toHaveLength(1));
    act(() => { rendered.result.current.loadWorkflow('proc-1'); });
    expect(rendered.result.current.elements[0].label).toBe('Start');
    return rendered;
  }

  it('keeps preview schema patches local', async () => {
    const { result } = await loadDefaultWorkflow();

    act(() => {
      window.dispatchEvent(new CustomEvent('konoha:schema_patch', {
        detail: {
          patch: { update_elements: [{ id: 'event-1', label: 'Preview Label' }] },
          mode: 'preview',
          workflow_id: 'proc-1',
        },
      }));
    });

    expect(result.current.elements[0].label).toBe('Preview Label');
    expect(result.current.autosavePending).toBe(true);
    expect(api.workflows.getFresh).not.toHaveBeenCalled();
  });

  it('reconciles committed optimistic patches to the saved backend workflow', async () => {
    (api.workflows.getFresh as any).mockResolvedValue({
      id: 'proc-1',
      name: 'Canonical Process',
      elements: [{ id: 'event-1', type: 'event', label: 'Saved Canonical', x: 140, y: 220 }],
      flow: [],
      version: '1.0.1',
    });
    const { result } = await loadDefaultWorkflow();

    act(() => {
      window.dispatchEvent(new CustomEvent('konoha:schema_patch', {
        detail: {
          patch: { update_elements: [{ id: 'event-1', label: 'Optimistic Label' }] },
          mode: 'committed',
          workflow_id: 'proc-1',
        },
      }));
    });
    expect(result.current.elements[0].label).toBe('Optimistic Label');
    expect(result.current.autosavePending).toBe(false);

    act(() => {
      window.dispatchEvent(new CustomEvent('konoha:workflow_patch_saved', {
        detail: { workflow_id: 'proc-1' },
      }));
    });

    await waitFor(() => expect(result.current.elements[0].label).toBe('Saved Canonical'));
    expect(result.current.wfName).toBe('Canonical Process');
    expect(result.current.positions['event-1']).toEqual({ x: 140, y: 220 });
    expect(api.workflows.getFresh).toHaveBeenCalledWith('proc-1');
  });

  it('does not apply pending or failed schema patches to the canvas', async () => {
    const { result } = await loadDefaultWorkflow();

    act(() => {
      window.dispatchEvent(new CustomEvent('konoha:schema_patch', {
        detail: {
          patch: { update_elements: [{ id: 'event-1', label: 'Pending Label' }] },
          mode: 'pending_confirmation',
          workflow_id: 'proc-1',
        },
      }));
      window.dispatchEvent(new CustomEvent('konoha:schema_patch', {
        detail: {
          patch: { update_elements: [{ id: 'event-1', label: 'Failed Label' }] },
          mode: 'failed',
          workflow_id: 'proc-1',
        },
      }));
    });

    expect(result.current.elements[0].label).toBe('Start');
    expect(result.current.autosavePending).toBe(false);
    expect(api.workflows.getFresh).not.toHaveBeenCalled();
  });

  it('ignores schema patches for a stale workflow id', async () => {
    const { result } = await loadDefaultWorkflow();

    act(() => {
      window.dispatchEvent(new CustomEvent('konoha:schema_patch', {
        detail: {
          patch: { update_elements: [{ id: 'event-1', label: 'Stale Label' }] },
          mode: 'committed',
          workflow_id: 'other-process',
        },
      }));
      window.dispatchEvent(new CustomEvent('konoha:workflow_patch_saved', {
        detail: { workflow_id: 'other-process' },
      }));
    });

    expect(result.current.elements[0].label).toBe('Start');
    expect(api.workflows.getFresh).not.toHaveBeenCalled();
  });
});
