import { randomUUID } from "crypto";
import {
  getWorkflow,
  listWorkflows,
  createWorkflow,
  updateWorkflow,
  archiveWorkflow,
  getWorkflowLifecycleState,
  mutateWorkflowAtomically,
  saveWorkflowDeployedSnapshot,
  getWorkflowDeployVersion,
  WORKFLOW_VALIDATION_TAXONOMY_VERSION,
  type WorkflowDefinition,
  type WorkflowElement,
  type FlowEdge,
  type WorkflowLifecycleState,
} from "./workflow-loader";
import { CaseStartGateError } from "./runtime/case-start-gate";
import { normalizeElementNames } from "./normalizer";
import { deleteCasesByProcess, createCase, getCase, listCases, forceCloseCase, cancelCase, deleteCase } from "./runtime";
import { resolveBatchProgrammatic, type ProcessContext } from "./trigger-resolver";
import { createSubscriptionProgrammatic, cancelSubscriptionsByProcessAndInstance, type TriggerDef } from "./event-manager";
import { validateActionArgs } from "./action-registry";
import {
  createStandaloneWorkItem,
  updateWorkItem,
  completeWorkItem,
  listWorkItems,
  deleteWorkItemsByProcess,
} from "./runtime/work-items";
import { createRole, deleteRole, listRoles, updateRole, type AssignmentStrategy } from "./runtime/roles";
import {
  createReminder,
  deleteReminder,
  listReminders,
  updateReminderStatus,
  type ReminderChannel,
  type ReminderStatus,
  type ReminderType,
} from "./runtime/reminders";
import { deleteCustomPerson, listPeople, upsertCustomPerson } from "./people-service";
import {
  addWhitelistedGroup,
  approvePendingAccess,
  listAccess,
  rejectPendingAccess,
  removeTrustedUser,
  removeWhitelistedGroup,
  upsertTrustedUser,
} from "./access-control";
import {
  getAgentDef,
  restartAgent,
  startAgent,
  stopAgent,
  updateAgentDef,
} from "./agent-lifecycle";
import { invokeAssistant } from "./assistant-invocation";
import { sendConnectorMessage } from "./messenger-outbound";
import { executeGithubIssueAction } from "./github-issue-actions";
import { sendMessage } from "./redis";
import { ServiceError } from "./errors";
import {
  buildPgOnlyRetentionCleanupApply,
  buildPgOnlyRetentionCleanupPreview,
  buildPgOnlyRetentionReport,
  retentionReportForAction,
} from "./retention/report";
import { cleanupExpiredRuntimeArtifacts, InvalidRuntimeRetentionPolicyError } from "./retention/runtime-cleanup";
import { buildWorkflowValidationReceipt } from "./workflow-validation-service";

export interface ActionExecution {
  status: number;
  data: unknown;
}

export interface WorkflowActionOptions {
  /**
   * Preserve legacy `/workflows` behavior: generate missing draft id/name and
   * coerce absent elements/flow to empty arrays before action validation.
   */
  compatibilityDefaults?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toWorkflowCreateArgs(args: Record<string, unknown>, opts: WorkflowActionOptions): Record<string, unknown> {
  const next = { ...args };
  if (opts.compatibilityDefaults) {
    next.id ??= randomUUID();
    next.name ??= `Draft ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
    next.elements ??= [];
    next.flow ??= [];
  }
  return next;
}

function validationFailure(action: string, args: Record<string, unknown>): ActionExecution | null {
  const validation = validateActionArgs(action, args);
  if (validation.valid) return null;
  return { status: 400, data: { error: "Validation failed", details: validation.errors } };
}

const ELEMENT_TYPES = new Set(["event", "function", "gateway"]);
const GATEWAY_OPERATORS = new Set(["AND", "OR", "XOR"]);
const WORKFLOW_RETIRE_MODES = new Set(["retire_only", "archive_with_runtime_cleanup", "purge_generated"]);

function buildElementAddPayload(args: Record<string, unknown>): { element?: WorkflowElement; error?: ActionExecution } {
  const invalid = validationFailure("element.add", args);
  if (invalid) return { error: invalid };

  const id = String(args.id).trim();
  const label = String(args.label).trim();
  const type = String(args.type);
  const role = args.role !== undefined ? String(args.role).trim() : undefined;
  const operator = args.operator !== undefined ? String(args.operator) : undefined;

  if (!id) {
    return { error: { status: 400, data: { error: "Invalid element schema", code: "INVALID_ELEMENT_SCHEMA", details: ["id must be a non-empty string"] } } };
  }
  if (!label) {
    return { error: { status: 400, data: { error: "Invalid element schema", code: "INVALID_ELEMENT_SCHEMA", details: ["label must be a non-empty string"] } } };
  }
  if (!ELEMENT_TYPES.has(type)) {
    return { error: { status: 400, data: { error: "Invalid element type", code: "INVALID_ELEMENT_TYPE", details: [`type must be one of: ${[...ELEMENT_TYPES].join(", ")}`] } } };
  }
  if (type === "function" && !role) {
    return { error: { status: 400, data: { error: "Invalid element schema", code: "INVALID_ELEMENT_SCHEMA", details: ["function elements require role"] } } };
  }
  if (type !== "function" && role) {
    return { error: { status: 400, data: { error: "Invalid element schema", code: "INVALID_ELEMENT_SCHEMA", details: ["role is only allowed for function elements"] } } };
  }
  if (type !== "gateway" && operator) {
    return { error: { status: 400, data: { error: "Invalid element schema", code: "INVALID_ELEMENT_SCHEMA", details: ["operator is only allowed for gateway elements"] } } };
  }
  if (type === "gateway" && operator && !GATEWAY_OPERATORS.has(operator)) {
    return { error: { status: 400, data: { error: "Invalid gateway operator", code: "INVALID_ELEMENT_SCHEMA", details: ["operator must be AND, OR, or XOR"] } } };
  }

  const element: WorkflowElement = {
    id,
    type: type as WorkflowElement["type"],
    label,
  };
  if (type === "function" && role) element.role = role;
  if (type === "gateway") element.operator = (operator ?? "XOR") as WorkflowElement["operator"];
  return { element };
}

function edgeFromArgs(args: Record<string, unknown>): { from?: string; to?: string; condition?: string; error?: ActionExecution } {
  const from = String(args.from ?? "").trim();
  const to = String(args.to ?? "").trim();
  const condition = args.condition !== undefined ? String(args.condition).trim() : undefined;
  const details: string[] = [];

  if (!from) details.push("from must be a non-empty string");
  if (!to) details.push("to must be a non-empty string");
  if (condition !== undefined && !condition) details.push("condition must be a non-empty string when provided");
  if (details.length > 0) {
    return { error: { status: 400, data: { error: "Invalid flow schema", code: "INVALID_FLOW_SCHEMA", details } } };
  }
  return { from, to, condition };
}

function flowEdge(from: string, to: string, condition?: string): FlowEdge {
  return condition ? [from, to, condition] : [from, to];
}

function edgeEndpoints(edge: FlowEdge): [string, string] {
  return [edge[0], edge[1]];
}

function hasEdge(flow: FlowEdge[] | undefined, from: string, to: string): boolean {
  return (flow ?? []).some(edge => {
    const [edgeFrom, edgeTo] = edgeEndpoints(edge);
    return edgeFrom === from && edgeTo === to;
  });
}

function normalizeResolvedTrigger(trigger: Awaited<ReturnType<typeof resolveBatchProgrammatic>>[number]["trigger"]): WorkflowElement["trigger"] | null {
  if (!trigger) return null;
  if (trigger.kind === "timer" && !trigger.cron && isRecord(trigger.delay_after)) {
    const delayAfter = trigger.delay_after as Record<string, unknown>;
    if (typeof delayAfter.duration === "string" && delayAfter.duration.trim() !== "") {
      return {
        kind: "delay_after",
        duration: delayAfter.duration,
        ...(typeof delayAfter.ref_event === "string" ? { ref_event: delayAfter.ref_event } : {}),
        confidence: trigger.confidence,
      };
    }
  }
  return trigger as WorkflowElement["trigger"];
}

function lifecycleUpdateOpts(current: WorkflowDefinition): { draft?: boolean; lifecycleState?: WorkflowLifecycleState } {
  const lifecycleState = getWorkflowLifecycleState(current);
  return lifecycleState === "draft" ? { draft: true } : { lifecycleState: "validated" };
}

async function normalizeElementsIfNeeded(body: Record<string, unknown>): Promise<boolean> {
  const elements = body.elements;
  if (!Array.isArray(elements) || elements.length === 0) return false;

  const nameMap = await normalizeElementNames(elements as WorkflowElement[]).catch((): Record<string, string> => ({}));
  if (Object.keys(nameMap).length === 0) return false;

  body.elements = (elements as WorkflowElement[]).map((el) =>
    nameMap[el.id] ? { ...el, label: nameMap[el.id] } : el,
  );
  return true;
}

async function resolveTriggers(
  elements: WorkflowElement[],
  processContext?: ProcessContext,
): Promise<{ elements: WorkflowElement[]; needs_review: boolean }> {
  const updatedElements = [...elements];
  const eventsToResolve = updatedElements
    .filter(el => el.type === "event" && !el.trigger?.kind && !el.trigger?.manual_override);

  if (eventsToResolve.length === 0) return { elements: updatedElements, needs_review: false };

  const ctx: ProcessContext = processContext ?? {};
  let results: Awaited<ReturnType<typeof resolveBatchProgrammatic>>;
  try {
    results = await Promise.race([
      resolveBatchProgrammatic(
        eventsToResolve.map(el => ({ id: el.id, label: el.label, manual_override: el.trigger?.manual_override })),
        ctx,
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("trigger resolver timed out after 60s")), 60_000),
      ),
    ]);
  } catch (e: any) {
    console.warn(`[workflow-deploy] trigger resolver failed (${e.message}), marking all events for manual review`);
    for (let i = 0; i < updatedElements.length; i++) {
      const el = updatedElements[i];
      if (el.type !== "event") continue;
      if (eventsToResolve.some(event => event.id === el.id)) {
        updatedElements[i] = { ...el, trigger: { kind: "ambiguous", confidence: 0 } };
      }
    }
    return { elements: updatedElements, needs_review: true };
  }

  let needs_review = false;
  const resultMap = new Map(results.map(r => [r.id, normalizeResolvedTrigger(r.trigger)]));

  for (let i = 0; i < updatedElements.length; i++) {
    const el = updatedElements[i];
    if (el.type !== "event") continue;
    if (!eventsToResolve.some(event => event.id === el.id)) continue;
    const resolved = resultMap.get(el.id);
    if (!resolved) {
      updatedElements[i] = { ...el, trigger: { kind: "ambiguous", candidates: [], confidence: 0 } };
      needs_review = true;
      continue;
    }

    updatedElements[i] = { ...el, trigger: resolved as WorkflowElement["trigger"] };

    if (resolved.kind === "ambiguous" || (resolved.confidence ?? 1) < 0.7) {
      needs_review = true;
    }
  }

  return { elements: updatedElements, needs_review };
}

async function subscribeStartEvents(def: WorkflowDefinition): Promise<void> {
  const cancelledCount = await cancelSubscriptionsByProcessAndInstance(def.id, "new");
  if (cancelledCount > 0) {
    console.log(`[workflow-deploy] cancelled ${cancelledCount} stale start-event sub(s) for process ${def.id}`);
  }

  const inCount = new Map<string, number>();
  for (const el of def.elements) inCount.set(el.id, 0);
  for (const [, to] of def.flow ?? []) inCount.set(to, (inCount.get(to) ?? 0) + 1);

  const startEvents = def.elements.filter((el) =>
    el.type === "event" && (inCount.get(el.id) ?? 0) === 0 && el.trigger?.kind && !el.trigger?.manual_override,
  );

  for (const el of startEvents) {
    try {
      await createSubscriptionProgrammatic({
        event_id: el.id,
        process_id: def.id,
        instance_id: "new",
        trigger: el.trigger as TriggerDef,
      });
      console.log(`[workflow-deploy] subscribed start event ${el.id} for process ${def.id}`);
    } catch (e: any) {
      console.error(`[workflow-deploy] failed to subscribe start event ${el.id}: ${e.message}`);
    }
  }
}

async function executeWorkflowCreate(args: Record<string, unknown>, opts: WorkflowActionOptions): Promise<ActionExecution> {
  const body = toWorkflowCreateArgs(args, opts);
  const invalid = validationFailure("workflow.create", body);
  if (invalid) return invalid;

  const draft = body.draft === true;
  const normalized = await normalizeElementsIfNeeded(body);

  const result = await createWorkflow(body as unknown as WorkflowDefinition, { draft });
  if (result.errors.length > 0) {
    return {
      status: 422,
      data: {
        error: "Validation failed",
        code: "WORKFLOW_VALIDATION_BLOCKED",
        validation: await buildWorkflowValidationReceipt(result.workflow, "workflow.create"),
        details: result.errors,
      },
    };
  }

  return { status: 201, data: { ...result.workflow, normalized } };
}

async function executeWorkflowUpdate(args: Record<string, unknown>): Promise<ActionExecution> {
  const invalid = validationFailure("workflow.update", args);
  if (invalid) return invalid;

  const id = String(args.id);
  const draft = args.draft === true;
  const body = { ...args };
  delete body.id;
  delete body.draft;

  const normalized = await normalizeElementsIfNeeded(body);

  const result = await updateWorkflow(id, body as Partial<WorkflowDefinition>, { draft });
  if (result === null) return { status: 404, data: { error: "Workflow not found" } };
  if (result.errors.length > 0) {
    return {
      status: 422,
      data: {
        error: "Validation failed",
        code: "WORKFLOW_VALIDATION_BLOCKED",
        workflow_id: id,
        validation: await buildWorkflowValidationReceipt(result.workflow, "workflow.update"),
        details: result.errors,
      },
    };
  }

  return { status: 200, data: { ...result.workflow, normalized } };
}

async function executeWorkflowValidate(args: Record<string, unknown>): Promise<ActionExecution> {
  const invalid = validationFailure("workflow.validate", args);
  if (invalid) return invalid;

  const id = String(args.id);
  const workflow = await getWorkflow(id);
  if (!workflow) return { status: 404, data: { error: "Workflow not found", code: "WORKFLOW_NOT_FOUND", workflow_id: id } };

  const validation = await buildWorkflowValidationReceipt(workflow, "workflow.validate");
  return { status: 200, data: validation };
}

function workflowNotFound(id: string): ActionExecution {
  return { status: 404, data: { error: "Workflow not found", code: "WORKFLOW_NOT_FOUND", workflow_id: id } };
}

async function executeWorkflowDeploy(args: Record<string, unknown>): Promise<ActionExecution> {
  const invalid = validationFailure("workflow.deploy", args);
  if (invalid) return invalid;

  const id = String(args.id);
  const current = await getWorkflow(id);
  if (!current) return workflowNotFound(id);
  const currentState = getWorkflowLifecycleState(current);
  if (currentState === "retired") {
    return {
      status: 409,
      data: {
        error: "Workflow is retired",
        code: "WORKFLOW_RETIRED",
        process_id: id,
        lifecycle_state: currentState,
        taxonomy_version: WORKFLOW_VALIDATION_TAXONOMY_VERSION,
        validation_issue: {
          code: "LIFECYCLE_RETIRED",
          severity: "error",
          class: "lifecycle",
          message: "Retired workflows cannot be deployed again",
          details: { lifecycle_state: currentState },
        },
      },
    };
  }

  const body: WorkflowDefinition = { ...current };
  const normalized = await normalizeElementsIfNeeded(body as unknown as Record<string, unknown>);
  let needs_review = false;

  if (Array.isArray(body.elements) && body.elements.length > 0) {
    const ctx: ProcessContext = {
      process_id: id,
      process_name: typeof body.name === "string" ? body.name : undefined,
      events: body.elements.filter(el => el.type === "event").map(el => ({ id: el.id, label: el.label })),
      functions: body.elements.filter(el => el.type === "function").map(el => ({ id: el.id, label: el.label })),
    };
    const resolved = await resolveTriggers(body.elements, ctx);
    body.elements = resolved.elements;
    needs_review = resolved.needs_review;
  }

  if (needs_review) {
    const validation = await buildWorkflowValidationReceipt(body, "workflow.deploy");
    const result = await updateWorkflow(id, body, {
      lifecycleState: "validated",
      deploy: {
        status: "blocked",
        checked_at: validation.checked_at,
        source: "workflow.deploy",
        details: validation.errors.length > 0
          ? validation.errors.map(error => `${error.code}: ${error.message}`)
          : ["DEPLOYMENT_TRIGGER_REVIEW_REQUIRED: trigger resolution needs manual review"],
      },
      needsReview: true,
    });
    if (result === null) return workflowNotFound(id);
    if (result.errors.length > 0) {
      return {
        status: 422,
        data: {
          error: "Validation failed",
          code: "WORKFLOW_VALIDATION_BLOCKED",
          process_id: id,
          validation,
          details: result.errors,
        },
      };
    }
    return {
      status: 409,
      data: {
        error: "Workflow deploy blocked by trigger review",
        code: "WORKFLOW_DEPLOY_NEEDS_REVIEW",
        process_id: id,
        lifecycle_state: "validated",
        validation,
        workflow: { ...result.workflow, normalized },
      },
    };
  }

  const validation = await buildWorkflowValidationReceipt(body, "workflow.deploy");
  if (validation.errors.length > 0) {
    const result = await updateWorkflow(id, body, {
      lifecycleState: "validated",
      deploy: {
        status: "blocked",
        checked_at: validation.checked_at,
        source: "workflow.deploy",
        details: validation.errors.map(error => `${error.code}: ${error.message}`),
      },
      needsReview: validation.gates.reviewer_required,
    });
    if (result === null) return workflowNotFound(id);
    if (result.errors.length > 0) return { status: 422, data: { error: "Validation failed", details: result.errors } };
    return {
      status: 422,
      data: {
        error: "Workflow deploy blocked by validation",
        code: "WORKFLOW_VALIDATION_BLOCKED",
        process_id: id,
        lifecycle_state: "validated",
        validation,
        workflow: { ...result.workflow, normalized },
      },
    };
  }

  const deployedAt = new Date().toISOString();
  const deployVersion = getWorkflowDeployVersion(current) + 1;
  const deployedBy = args.deployed_by ? String(args.deployed_by) : "system";
  const result = await updateWorkflow(id, body, {
    lifecycleState: "executable",
    deploy: {
      status: "succeeded",
      checked_at: deployedAt,
      deploy_version: deployVersion,
      deployed_at: deployedAt,
      deployed_by: deployedBy,
      source: "workflow.deploy",
      details: ["validation passed", "start-event subscriptions materialized"],
    },
    needsReview: false,
  });
  if (result === null) return workflowNotFound(id);
  if (result.errors.length > 0) return { status: 422, data: { error: "Validation failed", details: result.errors } };

  await subscribeStartEvents(result.workflow);
  await saveWorkflowDeployedSnapshot(result.workflow, "workflow.deploy");
  return { status: 200, data: { ...result.workflow, normalized } };
}

async function executeWorkflowRetire(action: "workflow.retire" | "workflow.delete", args: Record<string, unknown>): Promise<ActionExecution> {
  const invalid = validationFailure(action, args);
  if (invalid) return invalid;

  const id = String(args.id);
  const mode = String(args.mode ?? "archive_with_runtime_cleanup");
  if (!WORKFLOW_RETIRE_MODES.has(mode)) {
    return {
      status: 400,
      data: {
        error: "Invalid workflow retire mode",
        code: "WORKFLOW_RETIRE_INVALID_MODE",
        workflow_id: id,
        allowed_modes: [...WORKFLOW_RETIRE_MODES],
      },
    };
  }

  const current = await getWorkflow(id);
  if (!current) return workflowNotFound(id);
  const alreadyRetired = getWorkflowLifecycleState(current) === "retired";
  const retiredBy = action === "workflow.retire" && args.retired_by ? String(args.retired_by) : action;

  if (!alreadyRetired) {
    const archived = await archiveWorkflow(id, { source: action, retiredBy });
    if (!archived) return workflowNotFound(id);
  }

  let deletedCases = 0;
  let deletedWorkItems = 0;
  let cancelledSubscriptions = 0;
  const warnings: string[] = [];

  if (mode === "archive_with_runtime_cleanup" || mode === "purge_generated") {
    deletedCases = await deleteCasesByProcess(id).catch(() => { warnings.push("case cleanup failed"); return 0; });
    deletedWorkItems = await deleteWorkItemsByProcess(id).catch(() => { warnings.push("work item cleanup failed"); return 0; });
    cancelledSubscriptions = await cancelSubscriptionsByProcessAndInstance(id, "new").catch(() => { warnings.push("subscription cleanup failed"); return 0; });
  }

  return {
    status: 200,
    data: {
      ok: true,
      workflow_id: id,
      mode,
      action,
      retired: true,
      lifecycle_state: "retired",
      retired_by: alreadyRetired ? (current.retired_by ?? current.lifecycle?.retired_by ?? retiredBy) : retiredBy,
      already_retired: alreadyRetired,
      archived: true,
      deleted_cases: deletedCases,
      deleted_work_items: deletedWorkItems,
      cancelled_subscriptions: cancelledSubscriptions,
      warnings: warnings.length > 0 ? warnings : undefined,
    },
  };
}

async function executeWorkflowDelete(args: Record<string, unknown>): Promise<ActionExecution> {
  return executeWorkflowRetire("workflow.delete", args);
}

async function executeWorkflowBatchDelete(args: Record<string, unknown>): Promise<ActionExecution> {
  const invalid = validationFailure("workflow.batch_delete", args);
  if (invalid) return invalid;

  const ids = Array.isArray(args.ids) ? args.ids.map(String) : [];
  if (ids.length === 0) return { status: 400, data: { ok: false, error: "ids array required" } };
  if (ids.length > 50) return { status: 400, data: { ok: false, error: "Batch limit: 50 workflows per request" } };

  const results: { id: string; ok: boolean; deleted_cases: number; deleted_work_items: number; cancelled_subscriptions: number; error?: string }[] = [];
  for (const id of ids) {
    try {
      const archived = await archiveWorkflow(id);
      if (!archived) {
        results.push({ id, ok: false, deleted_cases: 0, deleted_work_items: 0, cancelled_subscriptions: 0, error: "Not found" });
        continue;
      }
      const deletedCases = await deleteCasesByProcess(id).catch(() => 0);
      const deletedWorkItems = await deleteWorkItemsByProcess(id).catch(() => 0);
      const cancelledSubscriptions = await cancelSubscriptionsByProcessAndInstance(id, "new").catch(() => 0);
      results.push({ id, ok: true, deleted_cases: deletedCases, deleted_work_items: deletedWorkItems, cancelled_subscriptions: cancelledSubscriptions });
    } catch (e: any) {
      results.push({ id, ok: false, deleted_cases: 0, deleted_work_items: 0, cancelled_subscriptions: 0, error: e.message });
    }
  }

  const deleted = results.filter(r => r.ok).length;
  const skipped = results.filter(r => !r.ok).length;
  const totalCases = results.reduce((sum, r) => sum + r.deleted_cases, 0);
  const totalWorkItems = results.reduce((sum, r) => sum + r.deleted_work_items, 0);
  const totalCancelledSubs = results.reduce((sum, r) => sum + r.cancelled_subscriptions, 0);

  return {
    status: 200,
    data: {
      ok: true,
      deleted_count: deleted,
      skipped_count: skipped,
      total_deleted_cases: totalCases,
      total_deleted_work_items: totalWorkItems,
      total_cancelled_subscriptions: totalCancelledSubs,
      results,
      summary: `Удалено процессов: ${deleted}, пропущено: ${skipped}, удалено прогонов: ${totalCases}, задач: ${totalWorkItems}, подписок: ${totalCancelledSubs}`,
    },
  };
}

export async function executeWorkflowAction(
  action: string,
  args: Record<string, unknown>,
  opts: WorkflowActionOptions = {},
): Promise<ActionExecution | null> {
  switch (action) {
    case "workflow.create":
      return executeWorkflowCreate(args, opts);
    case "workflow.update":
      return executeWorkflowUpdate(args);
    case "workflow.validate":
      return executeWorkflowValidate(args);
    case "workflow.deploy":
      return executeWorkflowDeploy(args);
    case "workflow.retire":
      return executeWorkflowRetire("workflow.retire", args);
    case "workflow.delete":
      return executeWorkflowDelete(args);
    case "workflow.batch_delete":
      return executeWorkflowBatchDelete(args);
    case "workflow.list":
      return { status: 200, data: await listWorkflows() };
    case "workflow.get": {
      const invalid = validationFailure("workflow.get", args);
      if (invalid) return invalid;
      const workflow = await getWorkflow(String(args.id));
      if (!workflow) return { status: 404, data: { error: "Workflow not found" } };
      return { status: 200, data: workflow };
    }
    default:
      return null;
  }
}

async function executeElementAction(action: string, args: Record<string, unknown>): Promise<ActionExecution | null> {
  switch (action) {
    case "element.add": {
      const { element, error } = buildElementAddPayload(args);
      if (error) return error;
      if (!element) return { status: 400, data: { error: "Invalid element schema", code: "INVALID_ELEMENT_SCHEMA" } };

      const workflowId = String(args.workflow_id);
      const result = await mutateWorkflowAtomically<{ added_element: WorkflowElement }, ActionExecution>(workflowId, current => {
        if ((current.elements ?? []).some(existing => existing.id === element.id)) {
          return {
            abort: {
              status: 409,
              data: {
                error: "Element ID already exists",
                code: "ELEMENT_ID_EXISTS",
                workflow_id: workflowId,
                element_id: element.id,
              },
            },
          };
        }

        const lifecycleState = getWorkflowLifecycleState(current);
        const updateOpts: { draft?: boolean; lifecycleState?: WorkflowLifecycleState } =
          lifecycleState === "draft" ? { draft: true } : { lifecycleState: "validated" };
        return {
          patch: { elements: [...(current.elements ?? []), element] },
          opts: updateOpts,
          meta: { added_element: element },
        };
      });

      if (result.status === "not_found") {
        return { status: 404, data: { error: "Workflow not found", code: "WORKFLOW_NOT_FOUND", workflow_id: workflowId } };
      }
      if (result.status === "conflict") {
        return { status: 409, data: { error: "Workflow mutation conflict", code: "WORKFLOW_MUTATION_CONFLICT", workflow_id: workflowId, attempts: result.attempts } };
      }
      if (result.status === "aborted") return result.meta;
      if (result.errors.length > 0) {
        return {
          status: 422,
          data: {
            error: "Validation failed",
            code: "WORKFLOW_VALIDATION_FAILED",
            workflow_id: workflowId,
            element_id: element.id,
            details: result.errors,
          },
        };
      }

      return { status: 200, data: { ...result.workflow, added_element: result.meta.added_element } };
    }
    default:
      return null;
  }
}

async function executeFlowAction(action: string, args: Record<string, unknown>): Promise<ActionExecution | null> {
  switch (action) {
    case "flow.add": {
      const invalid = validationFailure("flow.add", args);
      if (invalid) return invalid;
      const { from, to, condition, error } = edgeFromArgs(args);
      if (error) return error;
      if (!from || !to) return { status: 400, data: { error: "Invalid flow schema", code: "INVALID_FLOW_SCHEMA" } };

      const workflowId = String(args.workflow_id);
      const result = await mutateWorkflowAtomically<{ added_edge: FlowEdge }, ActionExecution>(workflowId, current => {
        const elementIds = new Set((current.elements ?? []).map(element => element.id));
        const missing = [from, to].filter(id => !elementIds.has(id));
        if (missing.length > 0) {
          return {
            abort: {
              status: 400,
              data: { error: "Invalid flow endpoints", code: "INVALID_FLOW_ENDPOINTS", workflow_id: workflowId, details: missing.map(id => `element not found: ${id}`) },
            },
          };
        }
        if (hasEdge(current.flow, from, to)) {
          return {
            abort: {
              status: 409,
              data: { error: "Flow edge already exists", code: "FLOW_EDGE_EXISTS", workflow_id: workflowId, from, to },
            },
          };
        }
        const edge = flowEdge(from, to, condition);
        return {
          patch: { flow: [...(current.flow ?? []), edge] },
          opts: lifecycleUpdateOpts(current),
          meta: { added_edge: edge },
        };
      });

      if (result.status === "not_found") return { status: 404, data: { error: "Workflow not found", code: "WORKFLOW_NOT_FOUND", workflow_id: workflowId } };
      if (result.status === "conflict") return { status: 409, data: { error: "Workflow mutation conflict", code: "WORKFLOW_MUTATION_CONFLICT", workflow_id: workflowId, attempts: result.attempts } };
      if (result.status === "aborted") return result.meta;
      if (result.errors.length > 0) {
        return {
          status: 422,
          data: { error: "Validation failed", code: "WORKFLOW_VALIDATION_FAILED", workflow_id: workflowId, edge: { from, to }, details: result.errors },
        };
      }
      return { status: 200, data: { ...result.workflow, added_edge: result.meta.added_edge } };
    }
    case "flow.remove": {
      const invalid = validationFailure("flow.remove", args);
      if (invalid) return invalid;
      const { from, to, error } = edgeFromArgs(args);
      if (error) return error;
      if (!from || !to) return { status: 400, data: { error: "Invalid flow schema", code: "INVALID_FLOW_SCHEMA" } };

      const workflowId = String(args.workflow_id);
      const result = await mutateWorkflowAtomically<{ removed_edge: FlowEdge }, ActionExecution>(workflowId, current => {
        const currentFlow = current.flow ?? [];
        const removed = currentFlow.find(edge => {
          const [edgeFrom, edgeTo] = edgeEndpoints(edge);
          return edgeFrom === from && edgeTo === to;
        });
        if (!removed) {
          return {
            abort: {
              status: 404,
              data: { error: "Flow edge not found", code: "FLOW_EDGE_NOT_FOUND", workflow_id: workflowId, from, to },
            },
          };
        }
        return {
          patch: {
            flow: currentFlow.filter(edge => {
              const [edgeFrom, edgeTo] = edgeEndpoints(edge);
              return !(edgeFrom === from && edgeTo === to);
            }),
          },
          opts: lifecycleUpdateOpts(current),
          meta: { removed_edge: removed },
        };
      });

      if (result.status === "not_found") return { status: 404, data: { error: "Workflow not found", code: "WORKFLOW_NOT_FOUND", workflow_id: workflowId } };
      if (result.status === "conflict") return { status: 409, data: { error: "Workflow mutation conflict", code: "WORKFLOW_MUTATION_CONFLICT", workflow_id: workflowId, attempts: result.attempts } };
      if (result.status === "aborted") return result.meta;
      if (result.errors.length > 0) {
        return {
          status: 422,
          data: { error: "Validation failed", code: "WORKFLOW_VALIDATION_FAILED", workflow_id: workflowId, edge: { from, to }, details: result.errors },
        };
      }
      return { status: 200, data: { ...result.workflow, removed_edge: result.meta.removed_edge } };
    }
    default:
      return null;
  }
}

async function executeCaseAction(action: string, args: Record<string, unknown>): Promise<ActionExecution | null> {
  switch (action) {
    case "case.start": {
      const invalid = validationFailure("case.start", args);
      if (invalid) return invalid;
      const processId = String(args.process_id);
      try {
        const kase = await createCase(
          processId,
          String(args.subject),
          (args.payload as Record<string, unknown>) ?? {},
          args.start_node ? String(args.start_node) : undefined,
          undefined,
          { adminOverride: args.admin_override === true, source: "case.start" },
        );
        return { status: 201, data: kase };
      } catch (e: any) {
        if (e instanceof CaseStartGateError) return { status: e.status, data: e.data };
        const isNotFound = e.message?.includes("not found");
        return { status: isNotFound ? 404 : 400, data: { error: e.message } };
      }
    }
    case "case.get": {
      const invalid = validationFailure("case.get", args);
      if (invalid) return invalid;
      const kase = await getCase(String(args.id));
      if (!kase) return { status: 404, data: { error: "Case not found" } };
      return { status: 200, data: kase };
    }
    case "case.list": {
      const filters: Record<string, unknown> = {};
      if (args.status) filters.status = args.status;
      if (args.process_id) filters.process_id = args.process_id;
      if (args.limit) filters.limit = Number(args.limit);
      if (args.offset) filters.offset = Number(args.offset);
      return { status: 200, data: await listCases(filters as any) };
    }
    case "case.close": {
      const invalid = validationFailure("case.close", args);
      if (invalid) return invalid;
      const kase = await forceCloseCase(String(args.id));
      if (!kase) return { status: 404, data: { error: "Case not found" } };
      return { status: 200, data: kase };
    }
    case "case.cancel": {
      const invalid = validationFailure("case.cancel", args);
      if (invalid) return invalid;
      const result = await cancelCase(String(args.id), args.reason ? String(args.reason) : undefined);
      if (!result) return { status: 404, data: { error: "Case not found", code: "CASE_NOT_FOUND", id: String(args.id) } };
      return { status: 200, data: { ...result.case, cancelled_work_items: result.cancelled_work_items } };
    }
    case "case.delete": {
      const invalid = validationFailure("case.delete", args);
      if (invalid) return invalid;
      const result = await deleteCase(String(args.id));
      if (!result) return { status: 404, data: { error: "Case not found", code: "CASE_NOT_FOUND", id: String(args.id) } };
      return {
        status: 200,
        data: {
          ok: true,
          deleted: true,
          case_id: result.case.case_id,
          process_id: result.case.process_id,
          deleted_work_items: result.deleted_work_items,
        },
      };
    }
    default:
      return null;
  }
}

async function executeWorkItemAction(action: string, args: Record<string, unknown>): Promise<ActionExecution | null> {
  switch (action) {
    case "workitem.complete": {
      const invalid = validationFailure("workitem.complete", args);
      if (invalid) return invalid;
      try {
        const result = await completeWorkItem(
          String(args.id),
          (args.output as Record<string, unknown>) ?? {},
        );
        return { status: 200, data: result };
      } catch (e: any) {
        if (e.message?.includes("not found")) return { status: 404, data: { error: e.message } };
        if (e.message?.includes("already")) return { status: 409, data: { error: e.message } };
        return { status: 400, data: { error: e.message } };
      }
    }
    case "workitem.create": {
      const invalid = validationFailure("workitem.create", args);
      if (invalid) return invalid;
      const wi = await createStandaloneWorkItem({
        label: String(args.label),
        assignee: String(args.assignee),
        input: args.input as Record<string, unknown> | undefined,
        deadline: args.deadline ? String(args.deadline) : undefined,
        process_id: args.process_id ? String(args.process_id) : undefined,
      });
      return { status: 201, data: wi };
    }
    case "workitem.update": {
      const invalid = validationFailure("workitem.update", args);
      if (invalid) return invalid;
      try {
        const patch: Record<string, unknown> = {};
        if (args.status !== undefined) patch.status = args.status;
        if (args.assignee !== undefined) patch.assignee = args.assignee;
        if (args.deadline !== undefined) patch.deadline = args.deadline;
        if (args.output !== undefined) patch.output = args.output;
        if (args.label !== undefined) patch.label = args.label;
        const wi = await updateWorkItem(String(args.id), patch as any);
        return { status: 200, data: wi };
      } catch (e: any) {
        if (e.message?.includes("not found")) return { status: 404, data: { error: e.message } };
        throw e;
      }
    }
    case "workitem.list": {
      const filters: Record<string, unknown> = {};
      if (args.assignee) filters.assignee = args.assignee;
      if (args.status) filters.status = args.status;
      if (args.process_id) filters.process_id = args.process_id;
      if (args.case_id) filters.case_id = args.case_id;
      if (args.deadline_before) filters.deadline_before = args.deadline_before;
      return { status: 200, data: await listWorkItems(filters as any) };
    }
    case "workitem.cancel": {
      const invalid = validationFailure("workitem.cancel", args);
      if (invalid) return invalid;
      try {
        const wi = await updateWorkItem(String(args.id), { status: "cancelled" } as any);
        return { status: 200, data: wi };
      } catch (e: any) {
        if (e.message?.includes("not found")) return { status: 404, data: { error: e.message } };
        throw e;
      }
    }
    default:
      return null;
  }
}

async function executeRoleAction(action: string, args: Record<string, unknown>): Promise<ActionExecution | null> {
  switch (action) {
    case "role.create": {
      const invalid = validationFailure("role.create", args);
      if (invalid) return invalid;
      const role = await createRole({
        role_id: String(args.role_id),
        name: String(args.name),
        description: args.description ? String(args.description) : undefined,
        assignees: Array.isArray(args.assignees) ? args.assignees.map(String) : [],
        strategy: (args.strategy ? String(args.strategy) : "manual") as AssignmentStrategy,
      });
      return { status: 201, data: role };
    }
    case "role.list":
      return { status: 200, data: await listRoles() };
    case "role.update": {
      const invalid = validationFailure("role.update", args);
      if (invalid) return invalid;
      try {
        const patch: Record<string, unknown> = {};
        if (args.name !== undefined) patch.name = args.name;
        if (args.description !== undefined) patch.description = args.description;
        if (args.assignees !== undefined) patch.assignees = args.assignees;
        if (args.strategy !== undefined) patch.strategy = args.strategy;
        const role = await updateRole(String(args.id), patch as any);
        return { status: 200, data: role };
      } catch (e: any) {
        if (e.message?.includes("not found")) return { status: 404, data: { error: e.message } };
        return { status: 400, data: { error: e.message } };
      }
    }
    case "role.delete": {
      const invalid = validationFailure("role.delete", args);
      if (invalid) return invalid;
      try {
        await deleteRole(String(args.id));
        return { status: 200, data: { ok: true } };
      } catch (e: any) {
        if (e.message?.includes("not found")) return { status: 404, data: { error: e.message } };
        return { status: 400, data: { error: e.message } };
      }
    }
    default:
      return null;
  }
}

async function executeReminderAction(action: string, args: Record<string, unknown>): Promise<ActionExecution | null> {
  switch (action) {
    case "reminder.create": {
      const invalid = validationFailure("reminder.create", args);
      if (invalid) return invalid;
      const reminder = await createReminder({
        type: (args.type ? String(args.type) : "standalone") as ReminderType,
        recipient: String(args.recipient),
        message: String(args.message),
        scheduled_at: String(args.scheduled_at),
        channel: (args.channel ? String(args.channel) : "gui") as ReminderChannel,
        case_id: args.case_id ? String(args.case_id) : undefined,
        process_id: args.process_id ? String(args.process_id) : undefined,
        element_id: args.element_id ? String(args.element_id) : undefined,
        work_item_id: args.work_item_id ? String(args.work_item_id) : undefined,
      });
      return { status: 201, data: reminder };
    }
    case "reminder.list": {
      const filters: Record<string, unknown> = {};
      if (args.status) filters.status = args.status;
      if (args.recipient) filters.recipient = args.recipient;
      return { status: 200, data: await listReminders(filters as any) };
    }
    case "reminder.update_status": {
      const invalid = validationFailure("reminder.update_status", args);
      if (invalid) return invalid;
      try {
        const reminder = await updateReminderStatus(String(args.id), String(args.status) as ReminderStatus);
        return { status: 200, data: reminder };
      } catch (e: any) {
        if (e.message?.includes("not found")) return { status: 404, data: { error: e.message } };
        return { status: 400, data: { error: e.message } };
      }
    }
    case "reminder.delete": {
      const invalid = validationFailure("reminder.delete", args);
      if (invalid) return invalid;
      try {
        await deleteReminder(String(args.id));
        return { status: 200, data: { ok: true } };
      } catch (e: any) {
        if (e.message?.includes("not found")) return { status: 404, data: { error: e.message } };
        return { status: 400, data: { error: e.message } };
      }
    }
    default:
      return null;
  }
}

function serviceFailure(error: unknown): ActionExecution {
  if (error instanceof ServiceError) return { status: error.status, data: { error: error.message } };
  const message = error instanceof Error ? error.message : "Internal error";
  return { status: 500, data: { error: message } };
}

async function executePersonAction(action: string, args: Record<string, unknown>): Promise<ActionExecution | null> {
  switch (action) {
    case "person.list":
      return { status: 200, data: await listPeople() };
    case "person.upsert": {
      const invalid = validationFailure("person.upsert", args);
      if (invalid) return invalid;
      try {
        return { status: 201, data: await upsertCustomPerson(args as any) };
      } catch (e) {
        return serviceFailure(e);
      }
    }
    case "person.delete": {
      const invalid = validationFailure("person.delete", args);
      if (invalid) return invalid;
      try {
        return { status: 200, data: await deleteCustomPerson(String(args.id)) };
      } catch (e) {
        return serviceFailure(e);
      }
    }
    default:
      return null;
  }
}

async function executeAccessAction(action: string, args: Record<string, unknown>): Promise<ActionExecution | null> {
  try {
    switch (action) {
      case "access.list":
        return { status: 200, data: listAccess() };
      case "access.approve": {
        const invalid = validationFailure("access.approve", args);
        if (invalid) return invalid;
        return { status: 200, data: approvePendingAccess(args as any) };
      }
      case "access.reject": {
        const invalid = validationFailure("access.reject", args);
        if (invalid) return invalid;
        return { status: 200, data: rejectPendingAccess(args as any) };
      }
      case "access.upsert_user": {
        const invalid = validationFailure("access.upsert_user", args);
        if (invalid) return invalid;
        return { status: 200, data: upsertTrustedUser(args as any) };
      }
      case "access.remove_user": {
        const invalid = validationFailure("access.remove_user", args);
        if (invalid) return invalid;
        return { status: 200, data: removeTrustedUser(Number(args.telegram_id)) };
      }
      case "access.add_group": {
        const invalid = validationFailure("access.add_group", args);
        if (invalid) return invalid;
        return { status: 200, data: addWhitelistedGroup(Number(args.chat_id)) };
      }
      case "access.remove_group": {
        const invalid = validationFailure("access.remove_group", args);
        if (invalid) return invalid;
        return { status: 200, data: removeWhitelistedGroup(Number(args.chat_id)) };
      }
      default:
        return null;
    }
  } catch (e) {
    return serviceFailure(e);
  }
}

async function executeAgentAction(action: string, args: Record<string, unknown>): Promise<ActionExecution | null> {
  switch (action) {
    case "agent.update_profile": {
      const invalid = validationFailure("agent.update_profile", args);
      if (invalid) return invalid;
      const id = String(args.id);
      const allowed = [
        "name",
        "display_alias",
        "system_prompt",
        "runtime",
        "fallback_runtime",
        "model",
        "llm_client_profile",
        "fallback_llm_client_profile",
        "reasoning_effort",
        "capabilities",
        "gender",
      ] as const;
      const updates: Record<string, unknown> = {};
      for (const key of allowed) {
        if (args[key] !== undefined) updates[key] = args[key];
      }
      if (Object.keys(updates).length === 0) {
        return { status: 400, data: { error: "No fields to update" } };
      }
      const updated = await updateAgentDef(id, updates as Parameters<typeof updateAgentDef>[1]);
      if (!updated) return { status: 404, data: { error: "Agent not found or not managed" } };
      return { status: 200, data: updated };
    }
    case "agent.start": {
      const invalid = validationFailure("agent.start", args);
      if (invalid) return invalid;
      const id = String(args.id);
      const def = await getAgentDef(id);
      if (!def) return { status: 404, data: { error: "Agent not found" } };
      try {
        return { status: 200, data: await startAgent(id, def) };
      } catch (e) {
        return serviceFailure(e);
      }
    }
    case "agent.stop": {
      const invalid = validationFailure("agent.stop", args);
      if (invalid) return invalid;
      const id = String(args.id);
      const def = await getAgentDef(id);
      if (!def) return { status: 404, data: { error: "Agent not found" } };
      try {
        return { status: 200, data: await stopAgent(id) };
      } catch (e) {
        return serviceFailure(e);
      }
    }
    case "agent.restart": {
      const invalid = validationFailure("agent.restart", args);
      if (invalid) return invalid;
      const id = String(args.id);
      const def = await getAgentDef(id);
      if (!def) return { status: 404, data: { error: "Agent not found" } };
      try {
        return { status: 200, data: await restartAgent(id, def) };
      } catch (e) {
        return serviceFailure(e);
      }
    }
    default:
      return null;
  }
}

async function executeConnectorAction(action: string, args: Record<string, unknown>): Promise<ActionExecution | null> {
  switch (action) {
    case "connector.send_message": {
      const invalid = validationFailure("connector.send_message", args);
      if (invalid) return invalid;
      try {
        return {
          status: 200,
          data: await sendConnectorMessage({
            connector_id: String(args.connector_id),
            endpoint_id: String(args.endpoint_id),
            chat_ref: String(args.chat_ref),
            text: String(args.text),
            reply_to: args.reply_to ? String(args.reply_to) : undefined,
            parse_mode: args.parse_mode ? String(args.parse_mode) : undefined,
            dry_run: args.dry_run === true,
            metadata: args.metadata as Record<string, unknown> | undefined,
          }),
        };
      } catch (e) {
        return serviceFailure(e);
      }
    }
    default:
      return null;
  }
}

async function executeAssistantAction(action: string, args: Record<string, unknown>): Promise<ActionExecution | null> {
  switch (action) {
    case "assistant.invoke": {
      const invalid = validationFailure("assistant.invoke", args);
      if (invalid) return invalid;
      try {
        return {
          status: 200,
          data: await invokeAssistant({
            assistant_id: String(args.assistant_id),
            message: String(args.message),
            conversation_id: typeof args.conversation_id === "string" ? args.conversation_id : undefined,
            context: args.context as Record<string, unknown> | undefined,
            operator_state: args.operator_state,
            schema: args.schema,
            stream: args.stream === true,
            execute_actions: args.execute_actions !== false,
            persist_history: args.persist_history !== false,
            fixture_response: typeof args.fixture_response === "string" ? args.fixture_response : undefined,
            include_raw_response: args.include_raw_response === true,
          }),
        };
      } catch (e) {
        return serviceFailure(e);
      }
    }
    default:
      return null;
  }
}

async function executeIssueAction(action: string, args: Record<string, unknown>): Promise<ActionExecution | null> {
  const invalid = validationFailure(action, args);
  if (invalid) return invalid;
  try {
    return await executeGithubIssueAction(action, args);
  } catch (e) {
    return serviceFailure(e);
  }
}

async function executeMessageAction(action: string, args: Record<string, unknown>): Promise<ActionExecution | null> {
  switch (action) {
    case "message.send": {
      const invalid = validationFailure("message.send", args);
      if (invalid) return invalid;
      try {
        const id = await sendMessage({
          from: typeof args.from === "string" ? args.from : "workflow",
          to: String(args.to),
          type: typeof args.type === "string" ? args.type as any : "message",
          text: String(args.text),
        });
        return { status: 200, data: { id } };
      } catch (e) {
        return serviceFailure(e);
      }
    }
    default:
      return null;
  }
}

async function executeRetentionAction(action: string, args: Record<string, unknown>): Promise<ActionExecution | null> {
  switch (action) {
    case "retention.report": {
      const invalid = validationFailure("retention.report", args);
      if (invalid) return invalid;
      try {
        const limit = typeof args.limit === "number" ? args.limit : 120;
        const report = await buildPgOnlyRetentionReport();
        return { status: 200, data: retentionReportForAction(report, limit) };
      } catch (e) {
        return serviceFailure(e);
      }
    }
    case "retention.cleanup_preview": {
      const invalid = validationFailure("retention.cleanup_preview", args);
      if (invalid) return invalid;
      try {
        const limit = typeof args.limit === "number" ? args.limit : 200;
        return { status: 200, data: await buildPgOnlyRetentionCleanupPreview({ limit }) };
      } catch (e) {
        return serviceFailure(e);
      }
    }
    case "retention.cleanup_apply": {
      const invalid = validationFailure("retention.cleanup_apply", args);
      if (invalid) return invalid;
      try {
        const result = await buildPgOnlyRetentionCleanupApply({
          confirm: args.confirm === true,
          candidates: Array.isArray(args.candidates) ? args.candidates : [],
        });
        return { status: result.applied ? 200 : 409, data: result };
      } catch (e) {
        return serviceFailure(e);
      }
    }
    case "retention.runtime_cleanup": {
      const invalid = validationFailure("retention.runtime_cleanup", args);
      if (invalid) return invalid;
      try {
        const result = await cleanupExpiredRuntimeArtifacts({
          dryRun: args.dry_run !== false,
          policy: {
            ...(typeof args.stuck_case_ttl_hours === "number" ? { stuckCaseTtlHours: args.stuck_case_ttl_hours } : {}),
            ...(typeof args.completed_workflow_ttl_hours === "number" ? { completedWorkflowTtlHours: args.completed_workflow_ttl_hours } : {}),
            ...(typeof args.max_delete === "number" ? { maxDelete: args.max_delete } : {}),
          },
        });
        return { status: 200, data: result };
      } catch (e) {
        if (e instanceof InvalidRuntimeRetentionPolicyError) {
          return { status: 400, data: { error: e.message, code: "INVALID_RUNTIME_RETENTION_POLICY", details: e.details } };
        }
        return serviceFailure(e);
      }
    }
    default:
      return null;
  }
}

export async function executeActionDirect(
  action: string,
  args: Record<string, unknown>,
  opts: WorkflowActionOptions = {},
): Promise<ActionExecution | null> {
  if (action.startsWith("workflow.")) {
    return executeWorkflowAction(action, args, opts);
  }
  if (action.startsWith("element.")) {
    return executeElementAction(action, args);
  }
  if (action.startsWith("flow.")) {
    return executeFlowAction(action, args);
  }
  if (action.startsWith("case.")) {
    return executeCaseAction(action, args);
  }
  if (action.startsWith("workitem.")) {
    return executeWorkItemAction(action, args);
  }
  if (action.startsWith("role.")) {
    return executeRoleAction(action, args);
  }
  if (action.startsWith("reminder.")) {
    return executeReminderAction(action, args);
  }
  if (action.startsWith("person.")) {
    return executePersonAction(action, args);
  }
  if (action.startsWith("access.")) {
    return executeAccessAction(action, args);
  }
  if (action.startsWith("agent.")) {
    return executeAgentAction(action, args);
  }
  if (action.startsWith("assistant.")) {
    return executeAssistantAction(action, args);
  }
  if (action.startsWith("connector.")) {
    return executeConnectorAction(action, args);
  }
  if (action.startsWith("issue.")) {
    return executeIssueAction(action, args);
  }
  if (action.startsWith("message.")) {
    return executeMessageAction(action, args);
  }
  if (action.startsWith("retention.")) {
    return executeRetentionAction(action, args);
  }
  return null;
}

export function assertActionArgs(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return value;
}
