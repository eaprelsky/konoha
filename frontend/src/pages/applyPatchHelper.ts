/**
 * applyPatchHelper — pure state transformation for SchemaPatch.
 * Extracted from useProcessEditor.applyPatch (issue #461) so the logic
 * can be unit-tested without a React environment.
 */
import type { WorkflowElement } from '../api/types';
import { genId, type Pos, type EType } from './ArrowRouter';
import type { SchemaPatch } from './useProcessEditor';

export interface PatchState {
  elements: WorkflowElement[];
  flow: [string, string, string?][];
  positions: Record<string, Pos>;
}

/** Labels used when an added element has no label. Mirrors DEFAULT_LABELS in ElementShape.tsx. */
const FALLBACK_LABELS: Record<string, string> = {
  event:              'Новое событие',
  function:           'Новая функция',
  gateway:            'Новое ветвление',
  role:               'Новая роль',
  executor:           'Новый исполнитель',
  document:           'Новый документ',
  information_system: 'Новая ИС',
  system:             'Новая система',
};

/**
 * Apply a SchemaPatch to an immutable state snapshot and return the updated state.
 * All fields are replaced, not mutated.
 */
export function applyPatchToState(state: PatchState, patch: SchemaPatch): PatchState {
  let { elements, flow, positions } = state;

  if (patch.update_elements?.length) {
    elements = elements.map(el => {
      const upd = patch.update_elements!.find(u => u.id === el.id);
      return upd ? { ...el, ...upd } : el;
    });
  }

  if (patch.update_positions && Object.keys(patch.update_positions).length > 0) {
    positions = { ...positions, ...patch.update_positions };
  }

  if (patch.add_elements?.length) {
    const newEls: WorkflowElement[] = patch.add_elements.map(ae => {
      const type = (ae.type as EType) || 'function';
      const id = (ae.id as string) || genId(type, elements);
      const label = (ae.label as string) || FALLBACK_LABELS[type] || 'Новый элемент';
      const x = typeof ae.x === 'number' ? ae.x : 100;
      const y = typeof ae.y === 'number' ? ae.y : 100;
      return { id, type, label, x, y } as WorkflowElement;
    });
    elements = [...elements, ...newEls];
    const newPositions = { ...positions };
    for (const el of newEls) newPositions[el.id] = { x: el.x ?? 100, y: el.y ?? 100 };
    positions = newPositions;
  }

  if (patch.remove_elements?.length) {
    const ids = new Set(patch.remove_elements);
    elements = elements.filter(e => !ids.has(e.id));
    flow = flow.filter(([f, t]) => !ids.has(f) && !ids.has(t));
    const newPositions = { ...positions };
    for (const id of ids) delete newPositions[id];
    positions = newPositions;
  }

  if (patch.add_flow?.length) {
    const existing = new Set(flow.map(([f, t]) => `${f}→${t}`));
    const toAdd = patch.add_flow.filter(([f, t]) => !existing.has(`${f}→${t}`));
    flow = [...flow, ...toAdd];
  }

  if (patch.remove_flow?.length) {
    const toRemove = new Set(patch.remove_flow.map(([f, t]) => `${f}→${t}`));
    flow = flow.filter(([f, t]) => !toRemove.has(`${f}→${t}`));
  }

  return { elements, flow, positions };
}
