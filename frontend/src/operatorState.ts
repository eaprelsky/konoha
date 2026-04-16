import type { DocTemplate, RoleDef, WorkflowElement } from './api/types';
import type { Pos } from './pages/ArrowRouter';

export const OPERATOR_STATE_VERSION = 'konoha.operator_state/v1';

export interface OperatorStateViewport {
  width: number;
  height: number;
  device_pixel_ratio: number;
  is_mobile: boolean;
}

export interface OperatorStateView {
  id: string;
  kind: 'process_editor';
  route: string;
  title: string;
  read_only: boolean;
  viewport: OperatorStateViewport;
}

export interface OperatorStateWorkflowElement {
  id: string;
  type: WorkflowElement['type'];
  label: string;
  role?: string;
  system?: string;
  operator?: string;
  ref_id?: string;
  locked?: boolean;
  intent?: string;
  trigger?: WorkflowElement['trigger'];
  position: Pos | null;
}

export interface OperatorStateWorkflowEdge {
  from_id: string;
  to_id: string;
  label?: string;
}

export interface OperatorStateWorkflow {
  id: string;
  name: string;
  is_known: boolean;
  viewing_version: string | null;
  breadcrumb: Array<{ id: string; name: string }>;
  element_count: number;
  edge_count: number;
  elements: OperatorStateWorkflowElement[];
  edges: OperatorStateWorkflowEdge[];
  canvas: {
    pan_x: number;
    pan_y: number;
    zoom: number;
  };
}

export interface OperatorStateSelection {
  mode: 'select' | 'connect';
  primary_selected_id: string | null;
  selected_ids: string[];
  hovered_id: string | null;
  connect_from_id: string | null;
  editing_id: string | null;
  gateway_picker_id: string | null;
}

export interface OperatorStatePending {
  saving: boolean;
  autosave_pending: boolean;
  trigger_resolving_ids: string[];
  draft_warning: { text: string; details: string[] } | null;
  confirmations: Array<{ id: string; kind: string; summary: string }>;
}

export interface OperatorStateChanges {
  has_local_changes: boolean;
  undo_depth: number;
  redo_depth: number;
}

export interface OperatorStateAffordances {
  can_edit: boolean;
  can_save: boolean;
  can_delete_selection: boolean;
  can_connect: boolean;
}

export interface ProcessEditorOperatorState {
  workflow: OperatorStateWorkflow;
  selection: OperatorStateSelection;
  pending: OperatorStatePending;
  changes: OperatorStateChanges;
  affordances: OperatorStateAffordances;
  registries: {
    roles: string[];
    documents: string[];
    adapters: string[];
  };
}

export interface OperatorStateEnvelope {
  version: typeof OPERATOR_STATE_VERSION;
  captured_at: string;
  current_view: OperatorStateView;
  current_process: ProcessEditorOperatorState | null;
}

export interface BuildProcessEditorOperatorStateInput {
  readOnly: boolean;
  wfId: string;
  wfName: string;
  isKnown: boolean;
  elements: WorkflowElement[];
  positions: Record<string, Pos>;
  flow: [string, string, string?][];
  selected: string | null;
  multiSelected: string[];
  hoveredEl: string | null;
  connectFrom: string | null;
  editingId: string | null;
  gatewayPickerId: string | null;
  mode: 'select' | 'connect';
  breadcrumb: Array<{ id: string; name: string }>;
  viewingVersion: string | null;
  panX: number;
  panY: number;
  zoom: number;
  saving: boolean;
  autosavePending: boolean;
  draftWarning: { text: string; details: string[] } | null;
  triggerResolving: Set<string>;
  undoDepth: number;
  redoDepth: number;
  roles: RoleDef[];
  docs: DocTemplate[];
  adapters: string[];
}

function uniqueSelectedIds(selected: string | null, multiSelected: string[]): string[] {
  const ordered = selected ? [selected, ...multiSelected] : [...multiSelected];
  return [...new Set(ordered.filter(Boolean))];
}

export function buildProcessEditorOperatorState(
  input: BuildProcessEditorOperatorStateInput,
): OperatorStateEnvelope {
  const selectedIds = uniqueSelectedIds(input.selected, input.multiSelected);
  const hasLocalChanges = input.undoDepth > 0 || input.autosavePending || input.saving;

  return {
    version: OPERATOR_STATE_VERSION,
    captured_at: new Date().toISOString(),
    current_view: {
      id: 'process_editor',
      kind: 'process_editor',
      route: `${window.location.pathname}${window.location.search}`,
      title: input.wfId ? `${input.wfName || input.wfId} (${input.wfId})` : 'Process editor',
      read_only: input.readOnly,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        device_pixel_ratio: window.devicePixelRatio,
        is_mobile: window.innerWidth <= 767,
      },
    },
    current_process: input.wfId
      ? {
          workflow: {
            id: input.wfId,
            name: input.wfName || input.wfId,
            is_known: input.isKnown,
            viewing_version: input.viewingVersion,
            breadcrumb: input.breadcrumb,
            element_count: input.elements.length,
            edge_count: input.flow.length,
            elements: input.elements.map((el) => ({
              id: el.id,
              type: el.type,
              label: el.label || el.id,
              ...(el.role ? { role: el.role } : {}),
              ...(el.system ? { system: el.system } : {}),
              ...(el.operator ? { operator: el.operator } : {}),
              ...(el.ref_id ? { ref_id: el.ref_id } : {}),
              ...(el.locked ? { locked: el.locked } : {}),
              ...(el.intent ? { intent: el.intent } : {}),
              ...(el.trigger ? { trigger: el.trigger } : {}),
              position: input.positions[el.id] ?? null,
            })),
            edges: input.flow.map(([from_id, to_id, label]) => ({
              from_id,
              to_id,
              ...(label ? { label } : {}),
            })),
            canvas: {
              pan_x: input.panX,
              pan_y: input.panY,
              zoom: input.zoom,
            },
          },
          selection: {
            mode: input.mode,
            primary_selected_id: input.selected,
            selected_ids: selectedIds,
            hovered_id: input.hoveredEl,
            connect_from_id: input.connectFrom,
            editing_id: input.editingId,
            gateway_picker_id: input.gatewayPickerId,
          },
          pending: {
            saving: input.saving,
            autosave_pending: input.autosavePending,
            trigger_resolving_ids: [...input.triggerResolving].sort(),
            draft_warning: input.draftWarning,
            confirmations: [],
          },
          changes: {
            has_local_changes: hasLocalChanges,
            undo_depth: input.undoDepth,
            redo_depth: input.redoDepth,
          },
          affordances: {
            can_edit: !input.readOnly,
            can_save: !input.readOnly && Boolean(input.wfName.trim()),
            can_delete_selection: !input.readOnly && selectedIds.length > 0,
            can_connect: !input.readOnly,
          },
          registries: {
            roles: input.roles.map((role) => role.name),
            documents: input.docs.map((doc) => doc.name),
            adapters: [...input.adapters],
          },
        }
      : null,
  };
}

export function summarizeOperatorState(state: OperatorStateEnvelope): string {
  const lines: string[] = [];
  lines.push(`Operator state: ${state.version}`);
  lines.push(`View: ${state.current_view.title}`);
  lines.push(`Route: ${state.current_view.route}`);
  lines.push(
    `Viewport: ${state.current_view.viewport.width}x${state.current_view.viewport.height} dpr=${state.current_view.viewport.device_pixel_ratio}`,
  );

  if (!state.current_process) {
    lines.push('Process: none selected');
    return lines.join('\n');
  }

  const process = state.current_process;
  lines.push(
    `Workflow: ${process.workflow.name} (${process.workflow.id}) · ${process.workflow.element_count} elements · ${process.workflow.edge_count} edges`,
  );
  if (process.selection.primary_selected_id) {
    lines.push(`Primary selection: ${process.selection.primary_selected_id}`);
  }
  if (process.selection.selected_ids.length > 0) {
    lines.push(`Selected IDs: ${process.selection.selected_ids.join(', ')}`);
  }
  if (process.pending.autosave_pending || process.pending.saving) {
    lines.push(
      `Pending: saving=${process.pending.saving} autosave=${process.pending.autosave_pending} trigger_resolving=${process.pending.trigger_resolving_ids.join(', ') || 'none'}`,
    );
  }
  if (process.changes.has_local_changes) {
    lines.push(`Local changes: undo=${process.changes.undo_depth} redo=${process.changes.redo_depth}`);
  }
  return lines.join('\n');
}
