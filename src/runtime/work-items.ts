/**
 * work-items.ts — Work item public CRUD + completeWorkItem.
 * Extracted from runtime.ts (issue #338).
 */
import { randomUUID } from "crypto";
import { redis } from "../redis";
import { pgPurgeAllWorkItems, pgGetWorkItem, pgListWorkItems } from "../storage/pg";
import { emitEvent } from "./event-log";
import {
  advanceCase, advancePastJoin,
  saveCase, loadCase,
  saveWorkItem, loadWorkItem, pgRowToWorkItem,
  WORKITEM_KEY_PREFIX, WORKITEMS_IDX_ALL, WORKITEMS_IDX_STATUS, WORKITEMS_IDX_ASSIGNEE, WORKITEMS_IDX_PROCESS,
  type Case, type WorkItem, type WorkItemStatus, type ActiveBranch,
} from "./cases";

const PG_READ = process.env.PG_READ === "true";

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
}): Promise<WorkItem> {
  const now = new Date().toISOString();
  const wi: WorkItem = {
    work_item_id: randomUUID(),
    case_id: null,
    process_id: null,
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
  if (wi.status === "done") throw new Error(`Work item "${work_item_id}" is already done`);

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

  const { getWorkflow } = await import("../workflow-loader");
  const def = await getWorkflow(kase.process_id);
  if (!def) throw new Error(`Workflow "${kase.process_id}" not found in registry`);

  if (kase.active_branches && kase.active_branches.length > 0) {
    const branch = kase.active_branches.find((b: ActiveBranch) => b.work_item_id === work_item_id);
    if (branch) {
      branch.done = true;
      await saveCase(kase);

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

export async function listWorkItems(filters: {
  assignee?: string;
  status?: WorkItemStatus;
  process_id?: string;
  deadline_before?: string;
}): Promise<WorkItem[]> {
  if (PG_READ) {
    const rows = await pgListWorkItems(filters);
    return rows.map(pgRowToWorkItem);
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

  if (filters.deadline_before) {
    const cutoff = new Date(filters.deadline_before).getTime();
    result = result.filter(wi => wi.deadline && new Date(wi.deadline).getTime() <= cutoff);
  }

  return result.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
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
