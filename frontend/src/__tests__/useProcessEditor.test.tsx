/**
 * useProcessEditor unit tests — issue #336
 * Tests: initial state, addElement, deleteElement, updateElement,
 *        removeEdge, undo/redo, newProcess, paletteClick, loadWorkflow
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useProcessEditor } from '../pages/useProcessEditor';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../api/client', () => ({
  api: {
    workflows: {
      list: vi.fn().mockResolvedValue([
        { id: 'proc-1', name: 'Test Process', elements: [{ id: 'event-1', type: 'event', label: 'Start' }], flow: [], version: '1.0.0' },
      ]),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
      versions: vi.fn().mockResolvedValue([]),
    },
    roles: { list: vi.fn().mockResolvedValue([]) },
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
