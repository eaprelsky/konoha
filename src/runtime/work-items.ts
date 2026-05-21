/**
 * work-items.ts — Work item public CRUD + completeWorkItem.
 * Extracted from runtime.ts (issue #338).
 */
import { randomUUID } from "crypto";
import { silentCatch } from "../logger";
import { redis, listAgents } from "../redis";
import { pgPurgeAllWorkItems, pgGetWorkItem, pgListWorkItems } from "../storage/pg";
import { emitEvent } from "./event-log";
import {
  advanceCase, advancePastJoin,
  saveCase, loadCase,
  saveWorkItem, loadWorkItem, pgRowToWorkItem,
  WORKITEM_KEY_PREFIX, WORKITEMS_IDX_ALL, WORKITEMS_IDX_STATUS, WORKITEMS_IDX_ASSIGNEE, WORKITEMS_IDX_PROCESS,
  type Case, type WorkItem, type WorkItemStatus, type ActiveBranch,
} from "./cases";
import { publishEvent } from "../redis";
import { createLogger } from "../logger";
import { dispatchWorkItem } from "../dispatcher";
import { loadWorkflowForCase } from "./cases/workflow-binding";

const log = createLogger("runtime:work-items");

const PG_READ = process.env.PG_READ === "true";
const TERMINAL_WORKITEM_STATUSES = new Set<WorkItemStatus>(["done", "cancelled", "error"]);

// Re-dispatch dedup: prevent infinite re-dispatch loops for stuck cases (#811)
const REDISPATCH_DEDUP_PREFIX = "workitem:redispatch:";
const REDISPATCH_DEDUP_TTL = 900; // 15 min window
const REDISPATCH_MAX_ATTEMPTS = 3;

export async function getWorkItem(work_item_id: string): Promise<WorkItem | null> {
  if (PG_READ) {
    const row = await pgGetWorkItem(work_item_id);
    return row ? pgRowToWorkItem(row) : null;
  }
  const raw = await redis.get(WORKITEM_KEY_PREFIX + work_item_id);
  return raw ? JSON.parse(raw) : null;
}

export async function createStandaloneWorkItem(params: {
  label: string;
  assignee: string;
  input?: Record<string, unknown>;
  deadline?: string;
  process_id?: string;
}): Promise<WorkItem> {
  const now = new Date().toISOString();
  const wi: WorkItem = {
    work_item_id: randomUUID(),
    case_id: null,
    process_id: params.process_id ?? null,
    element_id: null,
    label: params.label,
    assignee: params.assignee,
    status: "pending",
    input: params.input || {},
    deadline: params.deadline,
    created_at: now,
    updated_at: now,
  };
  await saveWorkItem(wi);
  return wi;
}

export async function updateWorkItem(
  work_item_id: string,
  patch: Partial<Pick<WorkItem, "status" | "assignee" | "deadline" | "output" | "label">>,
): Promise<WorkItem> {
  const wi = await loadWorkItem(work_item_id);
  if (!wi) throw new Error(`Work item "${work_item_id}" not found`);

  const prevStatus = wi.status;
  const prevAssignee = wi.assignee;

  if (patch.status !== undefined) wi.status = patch.status;
  if (patch.assignee !== undefined) wi.assignee = patch.assignee;
  if (patch.deadline !== undefined) wi.deadline = patch.deadline;
  if (patch.output !== undefined) wi.output = patch.output;
  if (patch.label !== undefined) wi.label = patch.label;
  wi.updated_at = new Date().toISOString();

  await saveWorkItem(wi, prevStatus, prevAssignee);
  return wi;
}

export async function completeWorkItem(
  work_item_id: string,
  output: Record<string, unknown> = {},
): Promise<{ workItem: WorkItem; case: Case | null }> {
  const wi = await loadWorkItem(work_item_id);
  if (!wi) throw new Error(`Work item "${work_item_id}" not found`);
  if (TERMINAL_WORKITEM_STATUSES.has(wi.status)) {
    throw new Error(`Work item "${work_item_id}" is already ${wi.status}`);
  }

  const prevStatus = wi.status;
  wi.status = "done";
  wi.output = output;
  wi.updated_at = new Date().toISOString();
  await saveWorkItem(wi, prevStatus);
  await emitEvent({
    type: "step.completed",
    case_id: wi.case_id ?? undefined,
    process_id: wi.process_id ?? undefined,
    work_item_id: wi.work_item_id,
    element_id: wi.element_id ?? undefined,
    label: wi.label,
    timestamp: wi.updated_at,
  });

  if (!wi.case_id) {
    return { workItem: wi, case: null };
  }

  const kase = await loadCase(wi.case_id);
  if (!kase) throw new Error(`Case "${wi.case_id}" not found`);

  const histEntry = kase.history.find(h => h.work_item_id === work_item_id);
  if (histEntry) histEntry.output = output;
  // Function output is process state: downstream gateways and functions must see it.
  kase.payload = { ...kase.payload, ...output };

  const def = await loadWorkflowForCase(kase);
  if (!def) throw new Error(`Workflow "${kase.process_id}" not found in registry`);

  if (kase.active_branches && kase.active_branches.length > 0) {
    const branch = kase.active_branches.find((b: ActiveBranch) => b.work_item_id === work_item_id);
    if (branch) {
      branch.done = true;
      await saveCase(kase);

      // Reload to detect concurrent branch completions (join race protection).
      // If another completion cleared active_branches via advancePastJoin, use that result.
      const reloaded = await loadCase(wi.case_id);
      if (reloaded && (!reloaded.active_branches || reloaded.active_branches.length === 0)) {
        return { workItem: wi, case: reloaded };
      }
      if (reloaded?.active_branches) {
        // Merge: ensure our branch is marked done in the reloaded copy
        const rb = reloaded.active_branches.find((b: ActiveBranch) => b.work_item_id === work_item_id);
        if (rb && !rb.done) {
          rb.done = true;
          await saveCase(reloaded);
        }
        if (reloaded.active_branches.every((b: ActiveBranch) => b.done)) {
          const updatedCase = await advancePastJoin(reloaded, def, reloaded.active_branches.map((b: ActiveBranch) => b.element_id));
          return { workItem: wi, case: updatedCase };
        }
        return { workItem: wi, case: reloaded };
      }

      if (kase.active_branches.every((b: ActiveBranch) => b.done)) {
        const updatedCase = await advancePastJoin(kase, def, kase.active_branches.map((b: ActiveBranch) => b.element_id));
        return { workItem: wi, case: updatedCase };
      }
      return { workItem: wi, case: kase };
    }
  }

  const updatedCase = await advanceCase(kase, def);
  return { workItem: wi, case: updatedCase };
}

export interface ListWorkItemsResult {
  items: WorkItem[];
  total: number;
  offset: number;
  limit: number;
}

export async function listWorkItems(filters: {
  assignee?: string;
  status?: WorkItemStatus;
  process_id?: string;
  case_id?: string;
  deadline_before?: string;
  offset?: number;
  limit?: number;
}): Promise<ListWorkItemsResult> {
  const offset = filters.offset ?? 0;
  const limit = filters.limit ?? 50;
  if (PG_READ) {
    const rows = await pgListWorkItems(filters);
    const all = rows.map(pgRowToWorkItem);
    all.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    const total = all.length;
    const items = all.slice(offset, offset + limit);
    return { items, total, offset, limit };
  }

  let candidateIds: Set<string> | null = null;

  function intersect(a: Set<string>, b: string[]): Set<string> {
    return new Set(b.filter(id => a.has(id)));
  }

  if (filters.assignee) {
    const ids = await redis.smembers(WORKITEMS_IDX_ASSIGNEE + filters.assignee);
    candidateIds = new Set(ids);
  }
  if (filters.status) {
    const ids = await redis.smembers(WORKITEMS_IDX_STATUS + filters.status);
    candidateIds = candidateIds ? intersect(candidateIds, ids) : new Set(ids);
  }
  if (filters.process_id) {
    const ids = await redis.smembers(WORKITEMS_IDX_PROCESS + filters.process_id);
    candidateIds = candidateIds ? intersect(candidateIds, ids) : new Set(ids);
  }
  if (!candidateIds) {
    const all = await redis.zrange(WORKITEMS_IDX_ALL, 0, -1);
    candidateIds = new Set(all);
  }

  const items = await Promise.all([...candidateIds].map(id => loadWorkItem(id)));
  let result = items.filter((wi): wi is WorkItem => wi !== null);

  if (filters.case_id) {
    result = result.filter(wi => wi.case_id === filters.case_id);
  }

  if (filters.deadline_before) {
    const cutoff = new Date(filters.deadline_before).getTime();
    result = result.filter(wi => wi.deadline && new Date(wi.deadline).getTime() <= cutoff);
  }

  // Sort by created_at descending (most recent first)
  result.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const total = result.length;
  const paged = result.slice(offset, offset + limit);
  return { items: paged, total, offset, limit };
}

async function scanKeys(pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [nextCursor, batch] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100) as [string, string[]];
    keys.push(...batch);
    cursor = nextCursor;
  } while (cursor !== "0");
  return keys;
}

export async function purgeAllWorkItems(): Promise<number> {
  const ids = await redis.zrange(WORKITEMS_IDX_ALL, 0, -1);
  if (ids.length === 0) return 0;
  await redis.del(...ids.map((id: string) => WORKITEM_KEY_PREFIX + id));
  const [statusKeys, assigneeKeys, processKeys] = await Promise.all([
    scanKeys(WORKITEMS_IDX_STATUS + "*"),
    scanKeys(WORKITEMS_IDX_ASSIGNEE + "*"),
    scanKeys(WORKITEMS_IDX_PROCESS + "*"),
  ]);
  const extraKeys = [...statusKeys, ...assigneeKeys, ...processKeys, WORKITEMS_IDX_ALL];
  if (extraKeys.length > 0) await redis.del(...extraKeys);
  pgPurgeAllWorkItems();
  return ids.length;
}

// ── Crash recovery ──────────────────────────────────────────────────────────

const STUCK_THRESHOLD_MS = 60_000; // 60 seconds — matches AC in #508

interface RecoveryResult {
  scanned: number;
  recovered: number;
  agentsOffline: string[];
}

/**
 * Scan for work items stuck in non-terminal states and recover them.
 * - Items in "running" or "pending" older than STUCK_THRESHOLD_MS are checked.
 * - If the assignee agent is offline, reset the work item to "pending" and
 *   emit a workitem.stuck event.
 * - Items whose assignee agent is back online are re-dispatched.
 *
 * Called periodically by Tsunade's healthcheck timer.
 */
export async function recoverStuckWorkItems(
  thresholdMs: number = STUCK_THRESHOLD_MS,
): Promise<RecoveryResult> {
  const now = Date.now();
  const cutoff = new Date(now - thresholdMs).toISOString();

  // Find work items in "running" or "pending" that haven't been updated recently
  const [runningIds, pendingIds] = await Promise.all([
    redis.smembers(WORKITEMS_IDX_STATUS + "running"),
    redis.smembers(WORKITEMS_IDX_STATUS + "pending"),
  ]);
  const candidateIds = new Set([...runningIds, ...pendingIds]);
  if (candidateIds.size === 0) {
    return { scanned: 0, recovered: 0, agentsOffline: [] };
  }

  // Load all work items and filter by age
  const items = await Promise.all(
    [...candidateIds].map(id => loadWorkItem(id)),
  );
  const stuck = items.filter((wi): wi is WorkItem =>
    wi !== null && wi.updated_at < cutoff,
  );

  if (stuck.length === 0) {
    return { scanned: candidateIds.size, recovered: 0, agentsOffline: [] };
  }

  // Build online agent set for quick lookup
  const onlineAgents = await listAgents(true);
  const onlineIds = new Set(onlineAgents.map(a => a.id));

  const recovered: string[] = [];
  const agentsOffline: string[] = [];

  for (const wi of stuck) {
    const assigneeOnline = onlineIds.has(wi.assignee);

    if (!assigneeOnline) {
      // Agent is offline — reset work item to "pending" and emit stuck event
      const prevStatus = wi.status;
      if (prevStatus === "running") {
        wi.status = "pending";
        wi.updated_at = new Date().toISOString();
        await saveWorkItem(wi, prevStatus);

        await publishEvent({
          type: "workitem.stuck",
          source: "runtime@comind.konoha",
          village_id: "comind.konoha",
          timestamp: new Date().toISOString(),
          payload: {
            work_item_id: wi.work_item_id,
            assignee: wi.assignee,
            label: wi.label,
            case_id: wi.case_id,
            previous_status: prevStatus,
            stuck_since: wi.updated_at,
          },
        }).catch(silentCatch("publish workitem.recovered event"));

        log.info("recovered stuck work item (agent offline)", {
          work_item_id: wi.work_item_id,
          assignee: wi.assignee,
          previous_status: prevStatus,
        });
        recovered.push(wi.work_item_id);
        if (!agentsOffline.includes(wi.assignee)) {
          agentsOffline.push(wi.assignee);
        }
      }
    } else if (wi.status === "pending" && wi.case_id && wi.assignee !== "unassigned") {
      // Agent is online but item is still pending — try re-dispatching (with dedup guard #811)
      const dedupKey = REDISPATCH_DEDUP_PREFIX + wi.work_item_id;
      try {
        const attempts = await redis.incr(dedupKey);
        if (attempts === 1) await redis.expire(dedupKey, REDISPATCH_DEDUP_TTL);
        if (attempts > REDISPATCH_MAX_ATTEMPTS) {
          log.warn("re-dispatch skipped: max attempts exceeded", {
            work_item_id: wi.work_item_id,
            assignee: wi.assignee,
            attempts,
          });
          continue;
        }

        const kase = await loadCase(wi.case_id);
        if (kase && kase.status === "running") {
          const def = await loadWorkflowForCase(kase);
          if (def && wi.element_id) {
            const el = def.elements.find(e => e.id === wi.element_id);
            if (el?.role) {
              await dispatchWorkItem({
                role: el.role,
                label: wi.label,
                work_item_id: wi.work_item_id,
                case_id: kase.case_id,
                process_id: kase.process_id,
                element_id: wi.element_id,
                docIds: el.documents || [],
                def,
                payload: kase.payload,
              });
              log.info("re-dispatched pending work item", {
                work_item_id: wi.work_item_id,
                assignee: wi.assignee,
              });
            }
          }
        }
      } catch (e: any) {
        log.warn("re-dispatch failed", { work_item_id: wi.work_item_id, error: e.message });
      }
    }
  }

  return { scanned: candidateIds.size, recovered: recovered.length, agentsOffline };
}

/** Delete all work items for a given process_id or case_ids. Returns count deleted. */
export async function deleteWorkItemsByProcess(processId: string): Promise<number> {
  const ids = await redis.smembers(WORKITEMS_IDX_PROCESS + processId);
  if (ids.length === 0) return 0;
  const BATCH = 200;
  let deleted = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const raws = await Promise.all(batch.map(id => redis.get(WORKITEM_KEY_PREFIX + id)));
    const pipe = redis.pipeline();
    for (let j = 0; j < batch.length; j++) {
      const wid = batch[j];
      const raw = raws[j];
      if (raw) {
        try {
          const wi = JSON.parse(raw as string);
          if (wi.status) pipe.srem(WORKITEMS_IDX_STATUS + wi.status, wid);
          if (wi.assignee) pipe.srem(WORKITEMS_IDX_ASSIGNEE + wi.assignee, wid);
        } catch {}
      }
      pipe.del(WORKITEM_KEY_PREFIX + wid);
      pipe.srem(WORKITEMS_IDX_PROCESS + processId, wid);
      pipe.zrem(WORKITEMS_IDX_ALL, wid);
    }
    await pipe.exec();
    deleted += batch.length;
  }
  return deleted;
}
