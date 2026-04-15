/**
 * runtime/cases/crud.ts — Public case API (create, get, list, delete, events).
 * Extracted from cases.ts (#507).
 */

import { redis } from "../../redis";
import { getWorkflow, type WorkflowDefinition } from "../../workflow-loader";
import { pgDeleteCasesByProcess } from "../../storage/pg";
import { emitEvent } from "../event-log";
import { cancelSubscriptionsByInstance } from "../../event-manager";
import { createLogger } from "../../logger";
import { loadActiveWaitsForCase, cancelEventWaitsForCase, resolveEventWaitForNode } from "../event-waits";
import { saveCase, loadCase, CASES_IDX_ALL, CASES_IDX_STATUS, CASES_IDX_PROCESS, CASE_KEY_PREFIX, WORKITEMS_IDX_CASE } from "./persistence";
import { buildAdjacency, advanceCase } from "./advancement";
import type { Case, CaseStatus } from "./types";

const log = createLogger("runtime:cases");
const PG_READ = process.env.PG_READ === "true";

// ── Public API ─────────────────────────────────────────────────────────────────

export async function createCase(
  process_id: string,
  subject: string,
  payload: Record<string, unknown> = {},
  start_node?: string,
  parentWorkItemId?: string,
): Promise<Case> {
  // Delegate to advancement.ts createCaseInner via dynamic import to avoid circular dep
  const { createCaseInner } = await import("./advancement");
  return createCaseInner(process_id, subject, payload, start_node, parentWorkItemId);
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

  // Cascade: close any child cases spawned by sub-process calls
  const wiIds = await redis.smembers(WORKITEMS_IDX_CASE + case_id).catch(() => [] as string[]);
  for (const wiId of wiIds) {
    const wi = await (await import("./persistence")).loadWorkItem(wiId);
    if (wi?.child_case_id) {
      await forceCloseCase(wi.child_case_id, _depth + 1);
    }
  }

  kase.status = "done";
  await saveCase(kase);
  cancelSubscriptionsByInstance(case_id).catch(e => log.warn("subscription cleanup on case complete", { case_id, error: e?.message }));
  cancelEventWaitsForCase(case_id).catch(e => log.warn("event wait cancel on case complete", { case_id, error: e?.message }));
  return kase;
}

export async function processEvent(
  eventType: string,
  subject: string,
  payload: Record<string, unknown>,
): Promise<Case[]> {
  const WORKFLOW_INDEX_KEY = "konoha:workflow:index";
  const WORKFLOW_KEY_PREFIX = "workflow:";
  const ids = await redis.smembers(WORKFLOW_INDEX_KEY);
  const cases: Case[] = [];

  for (const id of ids) {
    const raw = await redis.get(WORKFLOW_KEY_PREFIX + id);
    if (!raw) continue;
    const def: WorkflowDefinition = JSON.parse(raw);

    if (!def.triggers) continue;
    for (const trigger of def.triggers) {
      if (trigger.event_type !== eventType) continue;
      const kase = await createCase(def.id, subject, payload, trigger.start_node);
      cases.push(kase);
    }
  }

  return cases;
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
    const displayName = wfDef?.name || process_id;
    const subject = `${displayName} #${Date.now().toString(36).slice(-4)}`;
    const initPayload = source_data ?? {};
    try {
      const kase = await createCase(process_id, subject, initPayload, event_id);
      log.info("event_fired: new case created", { case_id: kase.case_id, process_id, event_id });
      return kase;
    } catch (e: any) {
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

  const def = await getWorkflow(kase.process_id);
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
    }
    await pipe.exec();
    deleted += batch.length;
  }
  await redis.del(CASES_IDX_PROCESS + process_id);
  return deleted;
}
