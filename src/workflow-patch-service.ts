import { listAdapters } from "./adapters";
import { listCases } from "./runtime";
import { listDocs } from "./runtime/documents";
import { listRoles } from "./runtime/roles";
import { listAgents } from "./redis";
import { listPeople } from "./people-directory";
import {
  getWorkflowDeployVersion,
  getWorkflowEditVersion,
  getWorkflowLifecycleState,
  mutateWorkflowAtomically,
  validateWorkflowReadiness,
  type FlowEdge,
  type WorkflowDefinition,
  type WorkflowElement,
  type WorkflowLifecycleState,
  type WorkflowValidationContext,
  type WorkflowValidationIssue,
  type WorkflowValidationReceipt,
} from "./workflow-loader";

export interface WorkflowSchemaPatch {
  set_name?: string;
  set_description?: string | null;
  add_elements?: WorkflowElement[];
  update_elements?: Array<Partial<WorkflowElement> & { id: string }>;
  remove_elements?: string[];
  add_flow?: FlowEdge[];
  remove_flow?: FlowEdge[];
  set_triggers?: Array<{ element_id: string; trigger: WorkflowElement["trigger"] | null }>;
}

export interface WorkflowPatchRequest {
  workflow_id: string;
  patch: WorkflowSchemaPatch;
  expected_deploy_version?: number;
  expected_edit_version?: number;
  idempotency_key?: string;
}

export interface WorkflowPatchChange {
  kind: "workflow" | "element" | "flow" | "trigger";
  id: string;
  change: "created" | "updated" | "removed" | "unchanged";
}

export interface WorkflowPatchReceipt {
  ok: true;
  action: "workflow.patch";
  workflow_id: string;
  idempotency_key?: string;
  changed_resources: WorkflowPatchChange[];
  validation: WorkflowValidationReceipt;
  lifecycle_state: WorkflowLifecycleState;
  deploy_version: number;
  workflow: WorkflowDefinition;
}

export type WorkflowPatchFailureCode =
  | "WORKFLOW_NOT_FOUND"
  | "WORKFLOW_RETIRED"
  | "WORKFLOW_PATCH_INVALID"
  | "WORKFLOW_PATCH_CONFLICT"
  | "WORKFLOW_PATCH_VALIDATION_FAILED"
  | "WORKFLOW_MUTATION_CONFLICT";

export interface WorkflowPatchFailure {
  ok: false;
  code: WorkflowPatchFailureCode;
  error: string;
  workflow_id?: string;
  status: number;
  details?: unknown;
  attempted_resources?: WorkflowPatchChange[];
  validation?: WorkflowValidationReceipt;
  attempts?: number;
}

interface PatchBuildResult {
  patch: Partial<WorkflowDefinition>;
  changed_resources: WorkflowPatchChange[];
}

interface WorkflowPatchMeta {
  changed_resources: WorkflowPatchChange[];
  validation: WorkflowValidationReceipt;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizePatch(raw: unknown): { patch?: WorkflowSchemaPatch; error?: WorkflowPatchFailure } {
  if (!isRecord(raw)) {
    return { error: patchInvalid("patch must be an object") };
  }

  const patch = raw as WorkflowSchemaPatch;
  const supportedKeys = [
    "set_name",
    "set_description",
    "add_elements",
    "update_elements",
    "remove_elements",
    "add_flow",
    "remove_flow",
    "set_triggers",
  ];
  if (!supportedKeys.some(key => Object.prototype.hasOwnProperty.call(patch, key))) {
    return { error: patchInvalid("patch must include at least one supported mutation") };
  }

  const details: string[] = [];
  if (patch.set_name !== undefined && (typeof patch.set_name !== "string" || patch.set_name.trim() === "")) {
    details.push("set_name must be a non-empty string");
  }
  if (patch.set_description !== undefined && patch.set_description !== null && typeof patch.set_description !== "string") {
    details.push("set_description must be a string or null");
  }
  validateArray(patch.add_elements, "add_elements", details);
  validateArray(patch.update_elements, "update_elements", details);
  validateStringArray(patch.remove_elements, "remove_elements", details);
  validateEdgeArray(patch.add_flow, "add_flow", details);
  validateEdgeArray(patch.remove_flow, "remove_flow", details);
  validateArray(patch.set_triggers, "set_triggers", details);

  for (const [index, element] of (patch.add_elements ?? []).entries()) {
    validateElementShape(element, `add_elements[${index}]`, details);
  }
  for (const [index, element] of (patch.update_elements ?? []).entries()) {
    if (!isRecord(element) || typeof element.id !== "string" || element.id.trim() === "") {
      details.push(`update_elements[${index}].id must be a non-empty string`);
      continue;
    }
    if (element.type !== undefined && !isWorkflowElementType(element.type)) {
      details.push(`update_elements[${index}].type must be event, function, or gateway`);
    }
  }
  for (const [index, item] of (patch.set_triggers ?? []).entries()) {
    if (!isRecord(item) || typeof item.element_id !== "string" || item.element_id.trim() === "") {
      details.push(`set_triggers[${index}].element_id must be a non-empty string`);
    }
    if (isRecord(item) && item.trigger !== null && item.trigger !== undefined && !isRecord(item.trigger)) {
      details.push(`set_triggers[${index}].trigger must be an object or null`);
    }
  }

  if (details.length > 0) return { error: patchInvalid(details) };
  return { patch };
}

function patchInvalid(details: unknown): WorkflowPatchFailure {
  return {
    ok: false,
    status: 400,
    code: "WORKFLOW_PATCH_INVALID",
    error: "Invalid workflow patch",
    details,
  };
}

function validateArray(value: unknown, field: string, details: string[]): void {
  if (value !== undefined && !Array.isArray(value)) details.push(`${field} must be an array`);
}

function validateStringArray(value: unknown, field: string, details: string[]): void {
  validateArray(value, field, details);
  if (!Array.isArray(value)) return;
  value.forEach((item, index) => {
    if (typeof item !== "string" || item.trim() === "") details.push(`${field}[${index}] must be a non-empty string`);
  });
}

function validateEdgeArray(value: unknown, field: string, details: string[]): void {
  validateArray(value, field, details);
  if (!Array.isArray(value)) return;
  value.forEach((edge, index) => {
    if (!Array.isArray(edge) || edge.length < 2 || edge.length > 3) {
      details.push(`${field}[${index}] must be [from, to, condition?]`);
      return;
    }
    const [from, to, condition] = edge;
    if (typeof from !== "string" || from.trim() === "" || typeof to !== "string" || to.trim() === "") {
      details.push(`${field}[${index}] endpoints must be non-empty strings`);
    }
    if (edge.length === 3 && typeof condition !== "string") {
      details.push(`${field}[${index}] condition must be a string`);
    }
  });
}

function isWorkflowElementType(value: unknown): value is WorkflowElement["type"] {
  return value === "event" || value === "function" || value === "gateway";
}

function validateElementShape(value: unknown, field: string, details: string[]): void {
  if (!isRecord(value)) {
    details.push(`${field} must be an object`);
    return;
  }
  if (typeof value.id !== "string" || value.id.trim() === "") details.push(`${field}.id must be a non-empty string`);
  if (!isWorkflowElementType(value.type)) details.push(`${field}.type must be event, function, or gateway`);
  if (typeof value.label !== "string" || value.label.trim() === "") details.push(`${field}.label must be a non-empty string`);
}

function edgeKey(edge: FlowEdge): string {
  return `${edge[0]}\u0000${edge[1]}`;
}

function edgeId(edge: FlowEdge): string {
  return edge.length > 2 ? `${edge[0]}:${edge[1]}:${edge[2]}` : `${edge[0]}:${edge[1]}`;
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function cloneElements(elements: WorkflowElement[] = []): WorkflowElement[] {
  return elements.map(element => ({ ...element }));
}

function cloneFlow(flow: FlowEdge[] = []): FlowEdge[] {
  return flow.map(edge => (edge.length > 2 ? [edge[0], edge[1], edge[2]] : [edge[0], edge[1]]) as FlowEdge);
}

function buildPatch(current: WorkflowDefinition, patch: WorkflowSchemaPatch): PatchBuildResult | WorkflowPatchFailure {
  const changedResources: WorkflowPatchChange[] = [];
  const next: Partial<WorkflowDefinition> = {};

  if (patch.set_name !== undefined) {
    next.name = patch.set_name.trim();
    changedResources.push({ kind: "workflow", id: current.id, change: next.name === current.name ? "unchanged" : "updated" });
  }
  if (patch.set_description !== undefined) {
    next.description = patch.set_description === null ? undefined : patch.set_description;
    changedResources.push({ kind: "workflow", id: current.id, change: next.description === current.description ? "unchanged" : "updated" });
  }

  const elements = cloneElements(current.elements);
  const elementsById = new Map(elements.map((element, index) => [element.id, { element, index }]));

  for (const element of patch.add_elements ?? []) {
    const existing = elementsById.get(element.id);
    if (existing) {
      if (!jsonEqual(existing.element, element)) {
        return patchConflict("Element ID already exists with different content", { element_id: element.id });
      }
      changedResources.push({ kind: "element", id: element.id, change: "unchanged" });
      continue;
    }
    const added = { ...element };
    elementsById.set(added.id, { element: added, index: elements.length });
    elements.push(added);
    changedResources.push({ kind: "element", id: added.id, change: "created" });
  }

  for (const update of patch.update_elements ?? []) {
    const existing = elementsById.get(update.id);
    if (!existing) return patchInvalidWithDetails("Element not found", { element_id: update.id });
    const nextElement = { ...existing.element, ...update, id: existing.element.id };
    elements[existing.index] = nextElement;
    elementsById.set(nextElement.id, { element: nextElement, index: existing.index });
    changedResources.push({ kind: "element", id: nextElement.id, change: jsonEqual(existing.element, nextElement) ? "unchanged" : "updated" });
  }

  const removeIds = new Set(patch.remove_elements ?? []);
  let flow = cloneFlow(current.flow);
  if (removeIds.size > 0) {
    for (const id of removeIds) {
      changedResources.push({ kind: "element", id, change: elementsById.has(id) ? "removed" : "unchanged" });
    }
    for (let i = elements.length - 1; i >= 0; i--) {
      if (removeIds.has(elements[i].id)) elements.splice(i, 1);
    }
    for (const id of removeIds) elementsById.delete(id);
    flow = flow.filter(edge => !removeIds.has(edge[0]) && !removeIds.has(edge[1]));
  }

  const flowByKey = new Map(flow.map((edge, index) => [edgeKey(edge), { edge, index }]));
  for (const edge of patch.add_flow ?? []) {
    const existing = flowByKey.get(edgeKey(edge));
    if (existing) {
      if (!jsonEqual(existing.edge, edge)) {
        return patchConflict("Flow edge already exists with different condition", { edge });
      }
      changedResources.push({ kind: "flow", id: edgeId(edge), change: "unchanged" });
      continue;
    }
    const added = (edge.length > 2 ? [edge[0], edge[1], edge[2]] : [edge[0], edge[1]]) as FlowEdge;
    flowByKey.set(edgeKey(added), { edge: added, index: flow.length });
    flow.push(added);
    changedResources.push({ kind: "flow", id: edgeId(added), change: "created" });
  }

  const removeFlowKeys = new Set((patch.remove_flow ?? []).map(edgeKey));
  if (removeFlowKeys.size > 0) {
    for (const edge of patch.remove_flow ?? []) {
      changedResources.push({ kind: "flow", id: edgeId(edge), change: flowByKey.has(edgeKey(edge)) ? "removed" : "unchanged" });
    }
    flow = flow.filter(edge => !removeFlowKeys.has(edgeKey(edge)));
  }

  for (const item of patch.set_triggers ?? []) {
    const existing = elementsById.get(item.element_id);
    if (!existing) return patchInvalidWithDetails("Trigger target element not found", { element_id: item.element_id });
    if (existing.element.type !== "event") return patchInvalidWithDetails("Triggers can only be set on event elements", { element_id: item.element_id });
    const nextElement = { ...existing.element };
    if (item.trigger === null) delete nextElement.trigger;
    else nextElement.trigger = item.trigger;
    elements[existing.index] = nextElement;
    elementsById.set(nextElement.id, { element: nextElement, index: existing.index });
    changedResources.push({ kind: "trigger", id: item.element_id, change: jsonEqual(existing.element.trigger, nextElement.trigger) ? "unchanged" : "updated" });
  }

  if (patch.add_elements || patch.update_elements || patch.remove_elements || patch.set_triggers) next.elements = elements;
  if (patch.add_flow || patch.remove_flow || patch.remove_elements) next.flow = flow;

  return { patch: next, changed_resources: changedResources };
}

function patchInvalidWithDetails(error: string, details: Record<string, unknown>): WorkflowPatchFailure {
  return {
    ok: false,
    status: 400,
    code: "WORKFLOW_PATCH_INVALID",
    error,
    details,
  };
}

function patchConflict(error: string, details: Record<string, unknown>): WorkflowPatchFailure {
  return {
    ok: false,
    status: 409,
    code: "WORKFLOW_PATCH_CONFLICT",
    error,
    details,
  };
}

function isWorkflowPatchFailure(value: PatchBuildResult | WorkflowPatchFailure): value is WorkflowPatchFailure {
  return "ok" in value && value.ok === false;
}

function patchLifecycleOpts(current: WorkflowDefinition): { lifecycleState: WorkflowLifecycleState; source: string } {
  const lifecycleState = getWorkflowLifecycleState(current);
  return {
    lifecycleState: lifecycleState === "draft" ? "draft" : "validated",
    source: "workflow.patch",
  };
}

function validationIssueDetails(errors: WorkflowValidationIssue[]): string[] {
  return errors.map(error => `${error.code}: ${error.message}`);
}

async function buildPatchValidationContext(workflowId: string): Promise<WorkflowValidationContext> {
  const [roles, documents, runningCases, agents, people] = await Promise.all([
    listRoles(),
    listDocs(),
    listCases({ process_id: workflowId, status: "running", limit: 1 }).catch(() => ({ cases: [], total: 0 })),
    listAgents(false).catch(() => undefined),
    listPeople().catch(() => undefined),
  ]);
  return {
    roles,
    documents,
    adapters: listAdapters(),
    ...(agents ? { agents } : {}),
    ...(people ? { people } : {}),
    running_case_count: runningCases.total,
    source: "workflow.patch",
  };
}

export async function applyWorkflowPatch(request: WorkflowPatchRequest): Promise<WorkflowPatchReceipt | WorkflowPatchFailure> {
  if (!request.workflow_id?.trim()) {
    return { ...patchInvalid("workflow_id must be a non-empty string"), workflow_id: request.workflow_id };
  }
  const normalized = normalizePatch(request.patch);
  if (normalized.error) return { ...normalized.error, workflow_id: request.workflow_id };
  const patch = normalized.patch!;
  const workflowId = request.workflow_id.trim();
  const validationContext = await buildPatchValidationContext(workflowId);

  const result = await mutateWorkflowAtomically<WorkflowPatchMeta, WorkflowPatchFailure>(
    workflowId,
    current => {
      const lifecycleState = getWorkflowLifecycleState(current);
      if (lifecycleState === "retired") {
        return {
          abort: {
            ok: false,
            status: 409,
            code: "WORKFLOW_RETIRED",
            error: "Retired workflows cannot be patched",
            workflow_id: workflowId,
            details: { lifecycle_state: lifecycleState },
          },
        };
      }
      if (
        request.expected_edit_version !== undefined &&
        getWorkflowEditVersion(current) !== request.expected_edit_version
      ) {
        return {
          abort: {
            ok: false,
            status: 409,
            code: "WORKFLOW_PATCH_CONFLICT",
            error: "Workflow edit version does not match expected_edit_version",
            workflow_id: workflowId,
            details: {
              expected_edit_version: request.expected_edit_version,
              actual_edit_version: getWorkflowEditVersion(current),
            },
          },
        };
      }
      if (
        request.expected_deploy_version !== undefined &&
        getWorkflowDeployVersion(current) !== request.expected_deploy_version
      ) {
        return {
          abort: {
            ok: false,
            status: 409,
            code: "WORKFLOW_PATCH_CONFLICT",
            error: "Workflow deploy version does not match expected_deploy_version",
            workflow_id: workflowId,
            details: {
              expected_deploy_version: request.expected_deploy_version,
              actual_deploy_version: getWorkflowDeployVersion(current),
            },
          },
        };
      }

      const built = buildPatch(current, patch);
      if (isWorkflowPatchFailure(built)) return { abort: { ...built, workflow_id: workflowId } };
      const candidate: WorkflowDefinition = { ...current, ...built.patch, id: workflowId };
      const validation = validateWorkflowReadiness(candidate, validationContext);
      if (validation.errors.length > 0) {
        return {
          abort: {
            ok: false,
            status: 422,
            code: "WORKFLOW_PATCH_VALIDATION_FAILED",
            error: "Workflow patch validation failed",
            workflow_id: workflowId,
            attempted_resources: built.changed_resources,
            validation,
            details: validationIssueDetails(validation.errors),
          },
        };
      }
      return {
        patch: built.patch,
        opts: patchLifecycleOpts(current),
        meta: { changed_resources: built.changed_resources, validation },
      };
    },
  );

  if (result.status === "not_found") {
    return { ok: false, status: 404, code: "WORKFLOW_NOT_FOUND", error: "Workflow not found", workflow_id: workflowId };
  }
  if (result.status === "conflict") {
    return {
      ok: false,
      status: 409,
      code: "WORKFLOW_MUTATION_CONFLICT",
      error: "Workflow mutation conflict",
      workflow_id: workflowId,
      attempts: result.attempts,
    };
  }
  if (result.status === "aborted") return result.meta;

  if (result.errors.length > 0) {
    const validation = result.meta.validation.errors.length > 0
      ? result.meta.validation
      : validateWorkflowReadiness(result.workflow, validationContext);
    return {
      ok: false,
      status: 422,
      code: "WORKFLOW_PATCH_VALIDATION_FAILED",
      error: "Workflow patch validation failed",
      workflow_id: workflowId,
      attempted_resources: result.meta.changed_resources,
      validation,
      details: validationIssueDetails(validation.errors),
    };
  }

  return {
    ok: true,
    action: "workflow.patch",
    workflow_id: workflowId,
    ...(request.idempotency_key ? { idempotency_key: request.idempotency_key } : {}),
    changed_resources: result.meta.changed_resources,
    validation: result.meta.validation,
    lifecycle_state: getWorkflowLifecycleState(result.workflow),
    deploy_version: getWorkflowDeployVersion(result.workflow),
    workflow: result.workflow,
  };
}
