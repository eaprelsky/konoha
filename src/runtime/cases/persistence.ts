/**
 * runtime/cases/persistence.ts — Redis key definitions, PG converters,
 * save/load helpers for Case and WorkItem.
 * Extracted from cases.ts (#507).
 */

import { redis } from "../../redis";
import {
  pgUpsertCase, pgUpsertWorkItem,
  pgGetCase, pgListCases, pgDeleteCasesByProcess,
  pgGetWorkItem, pgListWorkItems,
} from "../../storage/pg";
import { isPgReadEnabledFor } from "../../storage/pg-read-flags";
import type { Case, WorkItem, WorkItemStatus, CaseStatus } from "./types";
import { payloadWithWorkflowSnapshot, workflowSnapshotBindingFromPayload } from "./workflow-binding";

// ── Redis key prefixes ────────────────────────────────────────────────────────

export const CASE_KEY_PREFIX = "case:";
export const WORKITEM_KEY_PREFIX = "workitem:";
export const WORKITEMS_IDX_ASSIGNEE = "konoha:workitems:assignee:";
export const WORKITEMS_IDX_STATUS = "konoha:workitems:status:";
export const WORKITEMS_IDX_PROCESS = "konoha:workitems:process:";
export const WORKITEMS_IDX_CASE = "konoha:workitems:case:";
export const WORKITEMS_IDX_ALL = "konoha:workitems:all";
export const CASES_IDX_ALL = "konoha:cases:all";
export const CASES_IDX_STATUS = "konoha:cases:status:";
export const CASES_IDX_PROCESS = "konoha:cases:process:";
export const CASE_EVENTS_CHANNEL_PREFIX = "konoha:case-events:";

// ── PG row converters ─────────────────────────────────────────────────────────

function isoStr(v: unknown): string {
  if (!v) return new Date().toISOString();
  return v instanceof Date ? v.toISOString() : String(v);
}

export function pgRowToCase(row: Record<string, unknown>): Case {
  const raw = (row.payload ?? {}) as Record<string, unknown>;
  const { __active_branches, __workflow_snapshot, ...cleanPayload } = raw;
  const workflowSnapshot = workflowSnapshotBindingFromPayload({ __workflow_snapshot });
  return {
    case_id: String(row.case_id),
    process_id: String(row.process_id),
    process_version: String(row.version ?? ''),
    ...(workflowSnapshot ? { workflow_snapshot: workflowSnapshot } : {}),
    subject: String(row.subject ?? ''),
    status: (row.status ?? 'running') as CaseStatus,
    position: String(row.position ?? ''),
    active_branches: Array.isArray(__active_branches) ? __active_branches as Case['active_branches'] : undefined,
    payload: cleanPayload,
    history: Array.isArray(row.history) ? row.history as Case['history'] : [],
    created_at: isoStr(row.created_at),
  };
}

export function pgRowToWorkItem(row: Record<string, unknown>): WorkItem {
  return {
    work_item_id: String(row.id),
    case_id: row.case_id ? String(row.case_id) : null,
    process_id: row.process_id ? String(row.process_id) : null,
    element_id: row.element_id ? String(row.element_id) : null,
    label: String(row.label ?? ''),
    assignee: String(row.assignee ?? ''),
    status: (row.status ?? 'pending') as WorkItemStatus,
    input: (row.input ?? {}) as Record<string, unknown>,
    output: (row.output ?? {}) as Record<string, unknown>,
    deadline: row.deadline ? isoStr(row.deadline) : undefined,
    created_at: isoStr(row.created_at),
    updated_at: isoStr(row.updated_at),
  };
}

// ── Persistence helpers (exported for work-items.ts) ─────────────────────────

export async function saveCase(c: Case): Promise<void> {
  await redis.set(CASE_KEY_PREFIX + c.case_id, JSON.stringify(c));
  const withSnapshot = payloadWithWorkflowSnapshot(c.payload, c.workflow_snapshot);
  const pgPayload = c.active_branches ? { ...withSnapshot, __active_branches: c.active_branches } : withSnapshot;
  pgUpsertCase({ case_id: c.case_id, process_id: c.process_id, version: c.process_version, subject: c.subject, status: c.status, position: c.position, payload: pgPayload, history: c.history, created_at: c.created_at, updated_at: new Date().toISOString() });
  await redis.zadd(CASES_IDX_ALL, new Date(c.created_at).getTime(), c.case_id);
  const allStatuses: CaseStatus[] = ["running", "done", "error", "cancelled"];
  for (const s of allStatuses) {
    if (s !== c.status) await redis.srem(CASES_IDX_STATUS + s, c.case_id);
  }
  await redis.sadd(CASES_IDX_STATUS + c.status, c.case_id);
  await redis.sadd(CASES_IDX_PROCESS + c.process_id, c.case_id);
  await redis.publish(CASE_EVENTS_CHANNEL_PREFIX + c.case_id, JSON.stringify({ type: "case.updated", case: c })).catch(() => {});
}

export async function loadCase(case_id: string): Promise<Case | null> {
  if (isPgReadEnabledFor("cases")) {
    const row = await pgGetCase(case_id);
    return row ? pgRowToCase(row) : null;
  }
  const raw = await redis.get(CASE_KEY_PREFIX + case_id);
  return raw ? JSON.parse(raw) : null;
}

export async function saveWorkItem(wi: WorkItem, prevStatus?: WorkItemStatus, prevAssignee?: string): Promise<void> {
  await redis.set(WORKITEM_KEY_PREFIX + wi.work_item_id, JSON.stringify(wi));
  pgUpsertWorkItem({ id: wi.work_item_id, case_id: wi.case_id ?? undefined, process_id: wi.process_id ?? undefined, element_id: wi.element_id ?? undefined, label: wi.label, assignee: wi.assignee, status: wi.status, input: wi.input || {}, output: wi.output || {}, deadline: wi.deadline ?? undefined, created_at: wi.created_at, updated_at: new Date().toISOString() });
  if (prevAssignee && prevAssignee !== wi.assignee) {
    await redis.srem(WORKITEMS_IDX_ASSIGNEE + prevAssignee, wi.work_item_id);
  }
  await redis.sadd(WORKITEMS_IDX_ASSIGNEE + wi.assignee, wi.work_item_id);
  if (prevStatus && prevStatus !== wi.status) {
    await redis.srem(WORKITEMS_IDX_STATUS + prevStatus, wi.work_item_id);
  }
  await redis.sadd(WORKITEMS_IDX_STATUS + wi.status, wi.work_item_id);
  if (wi.process_id) {
    await redis.sadd(WORKITEMS_IDX_PROCESS + wi.process_id, wi.work_item_id);
  }
  if (wi.case_id) {
    await redis.sadd(WORKITEMS_IDX_CASE + wi.case_id, wi.work_item_id);
  }
  await redis.zadd(WORKITEMS_IDX_ALL, new Date(wi.created_at).getTime(), wi.work_item_id);
}

export async function loadWorkItem(work_item_id: string): Promise<WorkItem | null> {
  if (isPgReadEnabledFor("work_items")) {
    const row = await pgGetWorkItem(work_item_id);
    return row ? pgRowToWorkItem(row) : null;
  }
  const raw = await redis.get(WORKITEM_KEY_PREFIX + work_item_id);
  return raw ? JSON.parse(raw) : null;
}
