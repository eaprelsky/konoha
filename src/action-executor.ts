import { randomUUID } from "crypto";
import {
  getWorkflow,
  listWorkflows,
  createWorkflow,
  updateWorkflow,
  archiveWorkflow,
  type WorkflowDefinition,
  type WorkflowElement,
} from "./workflow-loader";
import { normalizeElementNames } from "./normalizer";
import { deleteCasesByProcess } from "./runtime";
import { resolveBatchProgrammatic, type ProcessContext } from "./trigger-resolver";
import { createSubscriptionProgrammatic, cancelSubscriptionsByProcessAndInstance, type TriggerDef } from "./event-manager";
import { validateActionArgs } from "./action-registry";

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
    return { elements: updatedElements, needs_review: true };
  }

  let needs_review = false;
  const resultMap = new Map(results.map(r => [r.id, r.trigger]));

  for (let i = 0; i < updatedElements.length; i++) {
    const el = updatedElements[i];
    if (el.type !== "event") continue;
    const resolved = resultMap.get(el.id);
    if (!resolved) continue;

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

  if (!draft && Array.isArray(body.elements) && body.elements.length > 0) {
    const ctx: ProcessContext = {
      process_id: String(body.id),
      process_name: typeof body.name === "string" ? body.name : undefined,
      events: (body.elements as WorkflowElement[]).filter(el => el.type === "event").map(el => ({ id: el.id, label: el.label })),
      functions: (body.elements as WorkflowElement[]).filter(el => el.type === "function").map(el => ({ id: el.id, label: el.label })),
    };
    const { elements, needs_review } = await resolveTriggers(body.elements as WorkflowElement[], ctx);
    body.elements = elements;
    if (needs_review) body.status = "needs_review";
  }

  const result = await createWorkflow(body as unknown as WorkflowDefinition, { draft });
  if (result.errors.length > 0) return { status: 422, data: { error: "Validation failed", details: result.errors } };

  if (!draft && !(result.workflow as any).status?.includes("needs_review")) {
    subscribeStartEvents(result.workflow).catch(e =>
      console.error(`[workflow-deploy] subscribeStartEvents error: ${e.message}`),
    );
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

  if (!draft && Array.isArray(body.elements) && body.elements.length > 0) {
    const ctx: ProcessContext = {
      process_id: id,
      process_name: typeof body.name === "string" ? body.name : undefined,
      events: (body.elements as WorkflowElement[]).filter(el => el.type === "event").map(el => ({ id: el.id, label: el.label })),
      functions: (body.elements as WorkflowElement[]).filter(el => el.type === "function").map(el => ({ id: el.id, label: el.label })),
    };
    const { elements, needs_review } = await resolveTriggers(body.elements as WorkflowElement[], ctx);
    body.elements = elements;
    if (needs_review) body.status = "needs_review";
  }

  const result = await updateWorkflow(id, body as Partial<WorkflowDefinition>, { draft });
  if (result === null) return { status: 404, data: { error: "Workflow not found" } };
  if (result.errors.length > 0) return { status: 422, data: { error: "Validation failed", details: result.errors } };

  if (!draft && !(result.workflow as any).status?.includes("needs_review")) {
    subscribeStartEvents(result.workflow).catch(e =>
      console.error(`[workflow-deploy] subscribeStartEvents update error: ${e.message}`),
    );
  }

  return { status: 200, data: { ...result.workflow, normalized } };
}

async function executeWorkflowDelete(args: Record<string, unknown>): Promise<ActionExecution> {
  const invalid = validationFailure("workflow.delete", args);
  if (invalid) return invalid;

  const id = String(args.id);
  const archived = await archiveWorkflow(id);
  if (!archived) return { status: 404, data: { error: "Workflow not found" } };
  const deletedCases = await deleteCasesByProcess(id).catch(() => 0);
  return { status: 200, data: { ok: true, archived: id, deleted_cases: deletedCases } };
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
    case "workflow.delete":
      return executeWorkflowDelete(args);
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

export async function executeActionDirect(
  action: string,
  args: Record<string, unknown>,
  opts: WorkflowActionOptions = {},
): Promise<ActionExecution | null> {
  if (action.startsWith("workflow.")) {
    return executeWorkflowAction(action, args, opts);
  }
  return null;
}

export function assertActionArgs(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return value;
}
