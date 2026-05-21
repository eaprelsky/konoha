/**
 * runtime/cases/crud.ts — Public case API (create, get, list, delete, events).
 * Extracted from cases.ts (#507).
 */

import { redis } from "../../redis";
import { getWorkflow, isWorkflowExecutable, type WorkflowDefinition } from "../../workflow-loader";
import { CaseStartGateError, type CaseStartGateOptions } from "../case-start-gate";
import { pgDeleteCase, pgDeleteCasesByProcess, pgDeleteWorkItem } from "../../storage/pg";
import { emitEvent } from "../event-log";
import { cancelSubscriptionsByInstance } from "../../event-manager";
import {
  evaluateActivationPolicy,
  recordActivationSuppression,
  type ActivationDecision,
} from "../../event-activation-policy";
import { createLogger } from "../../logger";
import { loadActiveWaitsForCase, cancelEventWaitsForCase, resolveEventWaitForNode } from "../event-waits";
import {
  saveCase,
  saveWorkItem,
  loadCase,
  loadWorkItem,
  CASES_IDX_ALL,
  CASES_IDX_STATUS,
  CASES_IDX_PROCESS,
  CASE_KEY_PREFIX,
  WORKITEM_KEY_PREFIX,
  WORKITEMS_IDX_ALL,
  WORKITEMS_IDX_ASSIGNEE,
  WORKITEMS_IDX_CASE,
  WORKITEMS_IDX_PROCESS,
  WORKITEMS_IDX_STATUS,
} from "./persistence";
import { buildAdjacency, advanceCase } from "./advancement";
import type { Case, CaseStatus } from "./types";
import { loadWorkflowForCase } from "./workflow-binding";

const log = createLogger("runtime:cases");
const PG_READ = process.env.PG_READ === "true";

// ── Public API ─────────────────────────────────────────────────────────────────

export async function createCase(
  process_id: string,
  subject: string,
  payload: Record<string, unknown> = {},
  start_node?: string,
  parentWorkItemId?: string,
  options: CaseStartGateOptions = {},
): Promise<Case> {
  // Delegate to advancement.ts createCaseInner via dynamic import to avoid circular dep
  const { createCaseInner } = await import("./advancement");
  return createCaseInner(process_id, subject, payload, start_node, parentWorkItemId, options);
}

export async function getCase(case_id: string): Promise<Case | null> {
  return loadCase(case_id);
}

export async function forceCloseCase(case_id: string, _depth = 0): Promise<Case | null> {
  if (_depth > 10) {
    log.warn("forceCloseCase: maxDepth exceeded, stopping recursion", { case_id });
    return null;
  }
  const kase = await loadCase(case_id);
  if (!kase) return null;
  if (kase.status !== "running") return kase;

  // Cascade: close any child cases spawned by sub-process calls.
  // Path 1: work items with child_case_id set
  const wiIds = await redis.smembers(WORKITEMS_IDX_CASE + case_id).catch(() => [] as string[]);
  for (const wiId of wiIds) {
    const wi = await (await import("./persistence")).loadWorkItem(wiId);
    if (wi?.child_case_id) {
      await forceCloseCase(wi.child_case_id, _depth + 1);
    }
  }

  // Path 2: cases whose parent_case_id points to this case (orphan-proof)
  const siblingIds = await redis.smembers(CASES_IDX_PROCESS + kase.process_id).catch(() => [] as string[]);
  for (const siblingId of siblingIds) {
    if (siblingId === case_id) continue;
    const sibling = await loadCase(siblingId);
    if (sibling?.parent_case_id === case_id && sibling.status === "running") {
      await forceCloseCase(sibling.case_id, _depth + 1);
    }
  }

  kase.status = "done";
  kase.active_branches = undefined;
  await saveCase(kase);
  cancelSubscriptionsByInstance(case_id).catch(e => log.warn("subscription cleanup on case complete", { case_id, error: e?.message }));
  cancelEventWaitsForCase(case_id).catch(e => log.warn("event wait cancel on case complete", { case_id, error: e?.message }));
  return kase;
}

async function cancelWorkItemsForCase(case_id: string): Promise<number> {
  const wiIds = await redis.smembers(WORKITEMS_IDX_CASE + case_id).catch(() => [] as string[]);
  let cancelled = 0;
  for (const wiId of wiIds) {
    const wi = await loadWorkItem(wiId);
    if (!wi || ["done", "cancelled", "error"].includes(wi.status)) continue;
    const prevStatus = wi.status;
    wi.status = "cancelled";
    wi.updated_at = new Date().toISOString();
    await saveWorkItem(wi, prevStatus);
    cancelled += 1;
  }
  return cancelled;
}

export async function cancelCase(case_id: string, reason?: string, _depth = 0): Promise<{ case: Case; cancelled_work_items: number } | null> {
  if (_depth > 10) {
    log.warn("cancelCase: maxDepth exceeded, stopping recursion", { case_id });
    return null;
  }
  const kase = await loadCase(case_id);
  if (!kase) return null;
  if (kase.status === "cancelled") return { case: kase, cancelled_work_items: 0 };
  if (kase.status !== "running") return { case: kase, cancelled_work_items: 0 };

  const wiIds = await redis.smembers(WORKITEMS_IDX_CASE + case_id).catch(() => [] as string[]);
  for (const wiId of wiIds) {
    const wi = await loadWorkItem(wiId);
    if (wi?.child_case_id) {
      await cancelCase(wi.child_case_id, reason, _depth + 1);
    }
  }

  const siblingIds = await redis.smembers(CASES_IDX_PROCESS + kase.process_id).catch(() => [] as string[]);
  for (const siblingId of siblingIds) {
    if (siblingId === case_id) continue;
    const sibling = await loadCase(siblingId);
    if (sibling?.parent_case_id === case_id && sibling.status === "running") {
      await cancelCase(sibling.case_id, reason, _depth + 1);
    }
  }

  const cancelledWorkItems = await cancelWorkItemsForCase(case_id);
  kase.status = "cancelled";
  kase.active_branches = undefined;
  kase.payload = {
    ...kase.payload,
    __cancelled_at: new Date().toISOString(),
    ...(reason ? { __cancel_reason: reason } : {}),
  };
  await saveCase(kase);
  cancelSubscriptionsByInstance(case_id).catch(e => log.warn("subscription cleanup on case cancel", { case_id, error: e?.message }));
  cancelEventWaitsForCase(case_id).catch(e => log.warn("event wait cancel on case cancel", { case_id, error: e?.message }));
  await emitEvent({
    type: "case.cancelled",
    case_id,
    process_id: kase.process_id,
    timestamp: new Date().toISOString(),
  }).catch(e => log.warn("case cancel event emit failed", { case_id, error: e?.message }));
  return { case: kase, cancelled_work_items: cancelledWorkItems };
}

export async function deleteCase(case_id: string): Promise<{ case: Case; deleted_work_items: number } | null> {
  const kase = await loadCase(case_id);
  if (!kase) return null;

  cancelSubscriptionsByInstance(case_id).catch(e => log.warn("subscription cleanup on case delete", { case_id, error: e?.message }));
  cancelEventWaitsForCase(case_id).catch(e => log.warn("event wait cancel on case delete", { case_id, error: e?.message }));

  const wiIds = await redis.smembers(WORKITEMS_IDX_CASE + case_id).catch(() => [] as string[]);
  const workItems = await Promise.all(wiIds.map(id => loadWorkItem(id)));
  const pipe = redis.pipeline();
  for (let i = 0; i < wiIds.length; i += 1) {
    const wiId = wiIds[i];
    const wi = workItems[i];
    pipe.del(WORKITEM_KEY_PREFIX + wiId);
    pipe.zrem(WORKITEMS_IDX_ALL, wiId);
    if (wi) {
      pipe.srem(WORKITEMS_IDX_STATUS + wi.status, wiId);
      pipe.srem(WORKITEMS_IDX_ASSIGNEE + wi.assignee, wiId);
      if (wi.process_id) pipe.srem(WORKITEMS_IDX_PROCESS + wi.process_id, wiId);
      if (wi.case_id) pipe.srem(WORKITEMS_IDX_CASE + wi.case_id, wiId);
    }
  }
  pipe.del(WORKITEMS_IDX_CASE + case_id);
  pipe.del(CASE_KEY_PREFIX + case_id);
  pipe.zrem(CASES_IDX_ALL, case_id);
  for (const status of ["running", "done", "error", "cancelled"]) {
    pipe.srem(CASES_IDX_STATUS + status, case_id);
  }
  pipe.srem(CASES_IDX_PROCESS + kase.process_id, case_id);
  await pipe.exec();

  await Promise.all(wiIds.map(wiId => pgDeleteWorkItem(wiId).catch(() => {})));
  await pgDeleteCase(case_id).catch(() => {});
  await redis.publish(`konoha:case-events:${case_id}`, JSON.stringify({ type: "case.deleted", case_id, process_id: kase.process_id })).catch(() => {});
  return { case: kase, deleted_work_items: wiIds.length };
}

export async function processEvent(
  eventType: string,
  source: string,
  payload: Record<string, unknown>,
  options: { workflowIds?: string[] } = {},
): Promise<Case[]> {
  const result = await processEventWithActivation(eventType, source, payload, options);
  return result.cases;
}

export async function processEventWithActivation(
  eventType: string,
  source: string,
  payload: Record<string, unknown>,
  options: { workflowIds?: string[] } = {},
): Promise<{ cases: Case[]; decisions: ActivationDecision[] }> {
  const WORKFLOW_INDEX_KEY = "konoha:workflow:index";
  const WORKFLOW_KEY_PREFIX = "workflow:";
  const ids = await redis.smembers(WORKFLOW_INDEX_KEY);
  const workflowIdScope = options.workflowIds ? new Set(options.workflowIds) : null;
  const cases: Case[] = [];
  const decisions: ActivationDecision[] = [];
  let matchedTrigger = false;

  for (const id of ids) {
    if (workflowIdScope && !workflowIdScope.has(id)) continue;
    const raw = await redis.get(WORKFLOW_KEY_PREFIX + id);
    if (!raw) continue;
    const def: WorkflowDefinition = JSON.parse(raw);
    if (!isWorkflowExecutable(def)) continue;

    if (!def.triggers) continue;
    for (const trigger of def.triggers) {
      if (trigger.event_type !== eventType) continue;
      const startNode = def.elements.find(el => el.id === trigger.start_node);
      const startTrigger = startNode?.type === "event" ? startNode.trigger : undefined;
      if (!eventMatchesStartTrigger(source, payload, startTrigger)) continue;
      matchedTrigger = true;

      const activationInput = {
        workflow_id: def.id,
        event_type: eventType,
        source,
        payload,
        policy: trigger.activation_policy ?? startTrigger?.activation_policy,
      };
      const activation = await evaluateActivationPolicy(activationInput);
      decisions.push(activation);
      if (!activation.accepted) {
        await recordActivationSuppression(activationInput, activation).catch(e =>
          log.warn("processEvent: failed to record activation suppression", {
            workflow_id: def.id,
            reason_code: activation.reason_code,
            error: e?.message,
          }),
        );
        continue;
      }

      const subject = eventSubject(source, payload);
      try {
        const kase = await createCase(def.id, subject, payload, trigger.start_node);
        cases.push(kase);
      } catch (e: any) {
        if (e instanceof CaseStartGateError) {
          log.warn("processEvent: case start blocked", {
            workflow_id: def.id,
            event_type: eventType,
            source,
            error: e.message,
            code: e.data.code,
            lifecycle_state: e.data.lifecycle_state,
          });
        } else {
          log.error("processEvent: create case failed", {
            workflow_id: def.id,
            event_type: eventType,
            source,
            error: e?.message,
          });
        }
      }
    }
  }

  if (!matchedTrigger && isMessengerSource(source, eventType)) {
    const activationInput = {
      workflow_id: workflowIdScope ? [...workflowIdScope].join(",") : "*",
      event_type: eventType,
      source,
      payload,
      policy: { inspect_suppressed: true },
    };
    const unmatched: ActivationDecision = {
      accepted: false,
      reason_code: "UNMATCHED_TRIGGER",
      action: "suppress",
      inspectable: true,
      detail: { workflow_scope: workflowIdScope ? [...workflowIdScope] : null },
    };
    decisions.push(unmatched);
    await recordActivationSuppression(activationInput, unmatched).catch(e =>
      log.warn("processEvent: failed to record unmatched activation", { event_type: eventType, source, error: e?.message }),
    );
  }

  return { cases, decisions };
}

function isMessengerSource(source: string, eventType: string): boolean {
  return ["telegram", "whatsapp", "email"].includes(source) || /^(telegram|whatsapp|email)\./.test(eventType);
}

function eventSubject(source: string, payload: Record<string, unknown>): string {
  for (const key of ["subject", "text", "message", "chat_title", "chat"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 160);
  }
  return source;
}

function eventMatchesStartTrigger(
  source: string,
  payload: Record<string, unknown>,
  trigger?: WorkflowDefinition["elements"][number]["trigger"],
): boolean {
  if (!trigger) return true;
  if (trigger.source && trigger.source !== source) return false;
  if (!trigger.filter) return true;

  for (const [key, expected] of Object.entries(trigger.filter)) {
    const actual = payload[key];
    if (Array.isArray(expected)) {
      if (!expected.includes(actual)) return false;
      continue;
    }
    if (actual !== expected) return false;
  }
  return true;
}

export async function handleEventFired(payload: {
  event_id: string;
  process_id: string;
  instance_id?: string;
  trigger_kind?: string;
  source_data?: Record<string, unknown>;
  idempotency_key?: string;
}): Promise<Case | null> {
  const { event_id, process_id, instance_id, source_data, idempotency_key } = payload;

  // Idempotency check: reject duplicate event delivery
  const dedupKey = idempotency_key
    ? `konoha:event-dedup:${idempotency_key}`
    : instance_id
      ? `konoha:event-dedup:${instance_id}:${event_id}:${Date.now().toString(36)}`
      : null;

  if (dedupKey && idempotency_key) {
    const set = await redis.set(dedupKey, "1", "EX", 300, "NX"); // 5 min TTL
    if (set !== "OK") {
      log.info("event_fired: duplicate suppressed", { idempotency_key, instance_id, event_id });
      return null;
    }
  }

  if (!instance_id || instance_id === "new") {
    const wfDef = await getWorkflow(process_id).catch(() => null);
    if (wfDef && !isWorkflowExecutable(wfDef)) {
      log.warn("event_fired: workflow not executable, skipped", {
        process_id,
        lifecycle_state: wfDef.lifecycle_state ?? wfDef.status,
      });
      return null;
    }
    const displayName = wfDef?.name || process_id;
    const subject = `${displayName} #${Date.now().toString(36).slice(-4)}`;
    const initPayload = source_data ?? {};
    try {
      const kase = await createCase(process_id, subject, initPayload, event_id);
      log.info("event_fired: new case created", { case_id: kase.case_id, process_id, event_id });
      return kase;
    } catch (e: any) {
      if (e instanceof CaseStartGateError) {
        log.warn("event_fired: case start blocked", {
          process_id,
          event_id,
          error: e.message,
          code: e.data.code,
          lifecycle_state: e.data.lifecycle_state,
        });
        return null;
      }
      log.error("event_fired: create case failed", { process_id, event_id, error: e.message });
      return null;
    }
  }

  const kase = await loadCase(instance_id);
  if (!kase) {
    log.warn("event_fired: case not found", { instance_id });
    return null;
  }
  if (kase.status !== "running") {
    log.warn("event_fired: case not running, skipped", { instance_id, status: kase.status });
    return null;
  }
  if (kase.position !== event_id) {
    log.warn("event_fired: position mismatch, skipped", { instance_id, position: kase.position, expected: event_id });
    return null;
  }

  const def = await loadWorkflowForCase(kase);
  if (!def) {
    log.error("event_fired: workflow not found", { process_id: kase.process_id, instance_id });
    return null;
  }

  if (source_data && Object.keys(source_data).length > 0) {
    kase.payload = { ...kase.payload, ...source_data };
  }

  try {
    // Resolve matching EventWait
    resolveEventWaitForNode(instance_id, event_id, source_data).catch(e =>
      log.warn("event_fired: failed to resolve event wait", { instance_id, event_id, error: e?.message }),
    );

    const updated = await advanceCase(kase, def);
    log.info("event_fired: case advanced", { instance_id, event_id, status: updated.status });
    return updated;
  } catch (e: any) {
    log.error("event_fired: advance failed", { instance_id, event_id, error: e.message });
    return null;
  }
}

export async function listCases(filters: {
  status?: CaseStatus;
  process_id?: string;
  after?: string;
  before?: string;
  limit?: number;
  offset?: number;
}): Promise<{ cases: Case[]; total: number }> {
  if (PG_READ) {
    const { pgListCases } = await import("../../storage/pg");
    const { pgRowToCase } = await import("./persistence");
    const { rows, total } = await pgListCases(filters);
    return { cases: rows.map(pgRowToCase), total };
  }

  let candidateIds: Set<string> | null = null;

  function intersect(a: Set<string>, b: string[]): Set<string> {
    return new Set(b.filter(id => a.has(id)));
  }

  if (filters.status) {
    const ids = await redis.smembers(CASES_IDX_STATUS + filters.status);
    candidateIds = new Set(ids);
  }
  if (filters.process_id) {
    const ids = await redis.smembers(CASES_IDX_PROCESS + filters.process_id);
    candidateIds = candidateIds ? intersect(candidateIds, ids) : new Set(ids);
  }

  const minScore = filters.after ? new Date(filters.after).getTime() : "-inf";
  const maxScore = filters.before ? new Date(filters.before).getTime() : "+inf";

  let allIds: string[];
  if (candidateIds) {
    const scored = await redis.zrangebyscore(CASES_IDX_ALL, minScore, maxScore);
    allIds = scored.filter((id: string) => candidateIds!.has(id));
  } else {
    allIds = await redis.zrangebyscore(CASES_IDX_ALL, minScore, maxScore);
  }

  const total = allIds.length;
  const offset = filters.offset ?? 0;
  const limit = filters.limit ?? 50;
  const pageIds = allIds.slice(offset, offset + limit);

  const cases = await Promise.all(pageIds.map(id => loadCase(id)));
  const page = cases.filter((c): c is Case => c !== null);
  return { cases: page, total };
}

/** Delete all cases (and their index entries) for a given process_id. Returns count deleted. */
export async function deleteCasesByProcess(process_id: string): Promise<number> {
  if (PG_READ) {
    return pgDeleteCasesByProcess(process_id);
  }

  const caseIds = await redis.smembers(CASES_IDX_PROCESS + process_id);
  if (caseIds.length === 0) return 0;

  const BATCH = 200;
  let deleted = 0;
  for (let i = 0; i < caseIds.length; i += BATCH) {
    const batch = caseIds.slice(i, i + BATCH);
    const raws = await Promise.all(batch.map(id => redis.get(CASE_KEY_PREFIX + id)));
    const pipe = redis.pipeline();
    for (let j = 0; j < batch.length; j++) {
      const cid = batch[j];
      const raw = raws[j];
      if (raw) {
        try {
          const c = JSON.parse(raw as string);
          pipe.srem(CASES_IDX_STATUS + c.status, cid);
        } catch {}
      }
      pipe.del(CASE_KEY_PREFIX + cid);
      pipe.zrem(CASES_IDX_ALL, cid);
      pipe.srem(CASES_IDX_PROCESS + process_id, cid);
      pipe.srem(CASES_IDX_STATUS + "cancelled", cid);
    }
    await pipe.exec();
    deleted += batch.length;
  }
  await redis.del(CASES_IDX_PROCESS + process_id);
  return deleted;
}
