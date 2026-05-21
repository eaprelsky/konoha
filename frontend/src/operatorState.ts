import type { DocTemplate, RoleDef, WorkflowElement } from './api/types';
import type { Pos } from './pages/ArrowRouter';
import { workflowLifecycleView, type WorkflowLifecycleState } from './workflowLifecycle';

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
  lifecycle_state: WorkflowLifecycleState;
  runnable: boolean;
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

export type OperatorAffordanceAvailability = 'available' | 'unavailable';
export type OperatorAffordanceScope = 'view' | 'workflow' | 'selection' | 'canvas';

export interface OperatorAffordanceDescriptor {
  id: string;
  action_id: string;
  scope: OperatorAffordanceScope;
  label: string;
  description: string;
  availability: OperatorAffordanceAvailability;
  reason?: string;
  suggested_args?: Record<string, unknown>;
}

export interface OperatorStateAffordances {
  can_edit: boolean;
  can_save: boolean;
  can_delete_selection: boolean;
  can_connect: boolean;
  actions: OperatorAffordanceDescriptor[];
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
  lifecycleState?: WorkflowLifecycleState;
}

function uniqueSelectedIds(selected: string | null, multiSelected: string[]): string[] {
  const ordered = selected ? [selected, ...multiSelected] : [...multiSelected];
  return [...new Set(ordered.filter(Boolean))];
}

function buildAffordanceActions(input: BuildProcessEditorOperatorStateInput, selectedIds: string[]): OperatorAffordanceDescriptor[] {
  const primarySelected = input.selected ? input.elements.find((el) => el.id === input.selected) ?? null : null;
  const selectedElements = selectedIds
    .map((id) => input.elements.find((el) => el.id === id) ?? null)
    .filter(Boolean) as WorkflowElement[];
  const hasLockedSelection = selectedElements.some((el) => el.locked);
  const selectedEvent = primarySelected?.type === 'event' ? primarySelected : null;
  const lifecycle = workflowLifecycleView({ lifecycle_state: input.lifecycleState ?? 'draft' });

  const actions: OperatorAffordanceDescriptor[] = [
    {
      id: 'case.start.current',
      action_id: 'case.start',
      scope: 'workflow',
      label: 'Start workflow run',
      description: 'Create a new case from the current workflow through the backend case.start gate.',
      availability: input.wfId && lifecycle.canStartCase ? 'available' : 'unavailable',
      ...(input.wfId && lifecycle.canStartCase
        ? { suggested_args: { process_id: input.wfId, subject: `${input.wfName || input.wfId} — manual run`, payload: {} } }
        : { reason: input.wfId ? lifecycle.runBlockedReason : 'No workflow is loaded.' }),
    },
    {
      id: 'workflow.get.current',
      action_id: 'workflow.get',
      scope: 'workflow',
      label: 'Inspect current workflow',
      description: 'Read the current workflow definition and versioned state.',
      availability: input.wfId ? 'available' : 'unavailable',
      ...(input.wfId ? { suggested_args: { id: input.wfId, snapshot: input.viewingVersion ?? undefined } } : { reason: 'No workflow is loaded.' }),
    },
    {
      id: 'workflow.update.current',
      action_id: 'workflow.update',
      scope: 'workflow',
      label: 'Save workflow changes',
      description: 'Persist current workflow structure and metadata.',
      availability: !input.readOnly && Boolean(input.wfId && input.wfName.trim()) ? 'available' : 'unavailable',
      ...(!input.readOnly && Boolean(input.wfId && input.wfName.trim())
        ? { suggested_args: { id: input.wfId } }
        : { reason: input.readOnly ? 'Editor is in read-only mode.' : 'Workflow must have an id and name before update.' }),
    },
    {
      id: 'workflow.delete.current',
      action_id: 'workflow.delete',
      scope: 'workflow',
      label: 'Delete current workflow',
      description: 'Archive the current workflow and cascade-delete dependent cases.',
      availability: !input.readOnly && input.isKnown ? 'available' : 'unavailable',
      ...(!input.readOnly && input.isKnown
        ? { suggested_args: { id: input.wfId } }
        : { reason: input.readOnly ? 'Editor is in read-only mode.' : 'Only persisted workflows can be deleted.' }),
    },
    {
      id: 'element.add.canvas',
      action_id: 'element.add',
      scope: 'canvas',
      label: 'Add workflow element',
      description: 'Add an event, function, gateway, or support element to the current workflow.',
      availability: !input.readOnly && Boolean(input.wfId) ? 'available' : 'unavailable',
      ...(!input.readOnly && Boolean(input.wfId)
        ? { suggested_args: { workflow_id: input.wfId } }
        : { reason: input.readOnly ? 'Editor is in read-only mode.' : 'Load or create a workflow first.' }),
    },
    {
      id: 'flow.add.canvas',
      action_id: 'flow.add',
      scope: 'canvas',
      label: 'Connect elements',
      description: 'Add a flow edge between workflow elements.',
      availability: !input.readOnly && input.elements.length >= 2 ? 'available' : 'unavailable',
      ...(!input.readOnly && input.elements.length >= 2
        ? { suggested_args: { workflow_id: input.wfId } }
        : { reason: input.readOnly ? 'Editor is in read-only mode.' : 'At least two elements are required to connect flow.' }),
    },
    {
      id: 'element.update.selection',
      action_id: 'element.update',
      scope: 'selection',
      label: 'Edit selected element',
      description: 'Change label, role, trigger, or other editable properties of the selected element.',
      availability: !input.readOnly && Boolean(primarySelected) ? 'available' : 'unavailable',
      ...(!input.readOnly && primarySelected
        ? { suggested_args: { workflow_id: input.wfId, id: primarySelected.id } }
        : { reason: input.readOnly ? 'Editor is in read-only mode.' : 'Select a primary element first.' }),
    },
    {
      id: 'element.remove.selection',
      action_id: 'element.remove',
      scope: 'selection',
      label: 'Delete selected element',
      description: 'Remove the selected element and its connected edges.',
      availability: !input.readOnly && Boolean(primarySelected) && !hasLockedSelection ? 'available' : 'unavailable',
      ...(!input.readOnly && primarySelected && !hasLockedSelection
        ? { suggested_args: { workflow_id: input.wfId, id: primarySelected.id } }
        : { reason: input.readOnly ? 'Editor is in read-only mode.' : hasLockedSelection ? 'Locked subprocess boundary elements cannot be removed.' : 'Select an element before removing it.' }),
    },
    {
      id: 'trigger.set.selection',
      action_id: 'trigger.set',
      scope: 'selection',
      label: 'Set trigger for selected event',
      description: 'Configure a timer, message, condition, or manual trigger on the selected event.',
      availability: !input.readOnly && Boolean(selectedEvent) ? 'available' : 'unavailable',
      ...(!input.readOnly && selectedEvent
        ? { suggested_args: { workflow_id: input.wfId, element_id: selectedEvent.id } }
        : { reason: input.readOnly ? 'Editor is in read-only mode.' : 'Select an event element to configure its trigger.' }),
    },
    {
      id: 'trigger.resolve.selection',
      action_id: 'trigger.resolve',
      scope: 'selection',
      label: 'Resolve trigger for selected event',
      description: 'Ask the trigger resolver to infer the selected event trigger kind from context.',
      availability: !input.readOnly && Boolean(selectedEvent) ? 'available' : 'unavailable',
      ...(!input.readOnly && selectedEvent
        ? { suggested_args: { workflow_id: input.wfId, element_id: selectedEvent.id } }
        : { reason: input.readOnly ? 'Editor is in read-only mode.' : 'Select an event element to resolve a trigger.' }),
    },
  ];

  return actions;
}

export function buildProcessEditorOperatorState(
  input: BuildProcessEditorOperatorStateInput,
): OperatorStateEnvelope {
  const selectedIds = uniqueSelectedIds(input.selected, input.multiSelected);
  const hasLocalChanges = input.undoDepth > 0 || input.autosavePending || input.saving;
  const lifecycle = workflowLifecycleView({ lifecycle_state: input.lifecycleState ?? 'draft' });
  const affordanceActions = buildAffordanceActions(input, selectedIds);

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
            lifecycle_state: lifecycle.state,
            runnable: lifecycle.canStartCase,
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
            actions: affordanceActions,
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
  const availableActions = process.affordances.actions
    .filter((action) => action.availability === 'available')
    .map((action) => action.action_id);
  const blockedActions = process.affordances.actions
    .filter((action) => action.availability === 'unavailable')
    .map((action) => `${action.action_id}${action.reason ? ` (${action.reason})` : ''}`);
  if (availableActions.length > 0) {
    lines.push(`Available actions: ${availableActions.join(', ')}`);
  }
  if (blockedActions.length > 0) {
    lines.push(`Blocked actions: ${blockedActions.join('; ')}`);
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
