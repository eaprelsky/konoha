import { randomUUID } from "crypto";
import { redis } from "./redis";
import { getWorkflow, type WorkflowDefinition, type WorkflowElement } from "./workflow-loader";

const CASE_KEY_PREFIX = "case:";
const WORKITEM_KEY_PREFIX = "workitem:";
const WORKITEMS_IDX_ASSIGNEE = "konoha:workitems:assignee:"; // set of workitem IDs
const WORKITEMS_IDX_STATUS = "konoha:workitems:status:";    // set of workitem IDs
const WORKFLOW_KEY_PREFIX = "workflow:";

// --- Types ---

export type CaseStatus = "running" | "done" | "error";
export type WorkItemStatus = "pending" | "done";

export interface HistoryEntry {
  element_id: string;
  element_type: string;
  label: string;
  timestamp: string;
  work_item_id?: string;
  output?: Record<string, unknown>;
}

export interface Case {
  case_id: string;
  process_id: string;
  process_version: string;
  subject: string;
  status: CaseStatus;
  position: string; // current element id
  payload: Record<string, unknown>;
  history: HistoryEntry[];
  created_at: string;
}

export interface WorkItem {
  work_item_id: string;
  case_id: string;
  element_id: string;
  label: string;
  assignee: string;
  status: WorkItemStatus;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  created_at: string;
}

// --- Helpers ---

async function saveCase(c: Case): Promise<void> {
  await redis.set(CASE_KEY_PREFIX + c.case_id, JSON.stringify(c));
}

async function loadCase(case_id: string): Promise<Case | null> {
  const raw = await redis.get(CASE_KEY_PREFIX + case_id);
  return raw ? JSON.parse(raw) : null;
}

async function saveWorkItem(wi: WorkItem): Promise<void> {
  await redis.set(WORKITEM_KEY_PREFIX + wi.work_item_id, JSON.stringify(wi));
  await redis.sadd(WORKITEMS_IDX_ASSIGNEE + wi.assignee, wi.work_item_id);
  await redis.sadd(WORKITEMS_IDX_STATUS + wi.status, wi.work_item_id);
}

async function loadWorkItem(work_item_id: string): Promise<WorkItem | null> {
  const raw = await redis.get(WORKITEM_KEY_PREFIX + work_item_id);
  return raw ? JSON.parse(raw) : null;
}

function buildAdjacency(def: WorkflowDefinition): {
  outEdges: Map<string, string[]>;
  inEdges: Map<string, string[]>;
  byId: Map<string, WorkflowElement>;
} {
  const byId = new Map<string, WorkflowElement>(def.elements.map(e => [e.id, e]));
  const outEdges = new Map<string, string[]>();
  const inEdges = new Map<string, string[]>();
  for (const el of def.elements) {
    outEdges.set(el.id, []);
    inEdges.set(el.id, []);
  }
  for (const [from, to] of def.flow) {
    outEdges.get(from)?.push(to);
    inEdges.get(to)?.push(from);
  }
  return { outEdges, inEdges, byId };
}

// --- Core advance logic (v1: linear chains only, no gateways) ---

async function advanceCase(kase: Case, def: WorkflowDefinition): Promise<Case> {
  const { outEdges, byId } = buildAdjacency(def);

  let current = kase.position;

  // Advance until we hit a function (create work item and stop) or a terminal event (close case)
  while (true) {
    const nexts = outEdges.get(current) || [];

    if (nexts.length === 0) {
      // Terminal element — if it's an event, close the case
      const el = byId.get(current);
      if (el?.type === "event") {
        kase.status = "done";
        kase.history.push({
          element_id: current,
          element_type: "event",
          label: el.label,
          timestamp: new Date().toISOString(),
        });
        await saveCase(kase);
        return kase;
      }
      // Unexpected terminal non-event
      kase.status = "error";
      await saveCase(kase);
      return kase;
    }

    // v1: take the first (and only) successor
    const nextId = nexts[0];
    const nextEl = byId.get(nextId);
    if (!nextEl) {
      kase.status = "error";
      await saveCase(kase);
      return kase;
    }

    if (nextEl.type === "function") {
      // Create work item and stop
      const work_item_id = randomUUID();
      const wi: WorkItem = {
        work_item_id,
        case_id: kase.case_id,
        element_id: nextId,
        label: nextEl.label,
        assignee: nextEl.role || "unassigned",
        status: "pending",
        input: kase.payload,
        created_at: new Date().toISOString(),
      };
      await saveWorkItem(wi);

      kase.position = nextId;
      kase.history.push({
        element_id: nextId,
        element_type: "function",
        label: nextEl.label,
        timestamp: wi.created_at,
        work_item_id,
      });
      await saveCase(kase);
      return kase;
    }

    if (nextEl.type === "event") {
      // Record event in history and continue advancing
      kase.position = nextId;
      kase.history.push({
        element_id: nextId,
        element_type: "event",
        label: nextEl.label,
        timestamp: new Date().toISOString(),
      });
      current = nextId;
      continue;
    }

    // gateway — not supported in v1
    kase.status = "error";
    await saveCase(kase);
    return kase;
  }
}

// --- Public API ---

export async function createCase(
  process_id: string,
  subject: string,
  payload: Record<string, unknown> = {},
  start_node?: string,
): Promise<Case> {
  const def = await getWorkflow(process_id);
  if (!def) throw new Error(`Workflow "${process_id}" not found in registry`);

  // Find the start node: use explicit start_node, or the first element with no incoming edges
  let startId = start_node;
  if (!startId) {
    const { inEdges } = buildAdjacency(def);
    const startEl = def.elements.find(el => (inEdges.get(el.id) || []).length === 0 && el.type === "event");
    if (!startEl) throw new Error(`Workflow "${process_id}" has no start event`);
    startId = startEl.id;
  }

  const startEl = def.elements.find(e => e.id === startId);
  if (!startEl) throw new Error(`Start node "${startId}" not found in workflow "${process_id}"`);

  const case_id = randomUUID();
  const now = new Date().toISOString();

  const kase: Case = {
    case_id,
    process_id,
    process_version: def.version,
    subject,
    status: "running",
    position: startId,
    payload,
    history: [{
      element_id: startId,
      element_type: startEl.type,
      label: startEl.label,
      timestamp: now,
    }],
    created_at: now,
  };

  await saveCase(kase);

  // Advance to the first work item
  return advanceCase(kase, def);
}

export async function getCase(case_id: string): Promise<Case | null> {
  return loadCase(case_id);
}

export async function completeWorkItem(
  work_item_id: string,
  output: Record<string, unknown> = {},
): Promise<{ workItem: WorkItem; case: Case }> {
  const wi = await loadWorkItem(work_item_id);
  if (!wi) throw new Error(`Work item "${work_item_id}" not found`);
  if (wi.status === "done") throw new Error(`Work item "${work_item_id}" is already done`);

  const kase = await loadCase(wi.case_id);
  if (!kase) throw new Error(`Case "${wi.case_id}" not found`);

  // Update work item status indices
  await redis.srem(WORKITEMS_IDX_STATUS + "pending", work_item_id);
  await redis.sadd(WORKITEMS_IDX_STATUS + "done", work_item_id);

  wi.status = "done";
  wi.output = output;
  await saveWorkItem(wi);

  // Update case history entry with output
  const histEntry = kase.history.find(h => h.work_item_id === work_item_id);
  if (histEntry) histEntry.output = output;

  const def = await getWorkflow(kase.process_id);
  if (!def) throw new Error(`Workflow "${kase.process_id}" not found in registry`);

  // Advance case from the completed function
  const updatedCase = await advanceCase(kase, def);
  return { workItem: wi, case: updatedCase };
}

export async function listWorkItems(filters: {
  assignee?: string;
  status?: WorkItemStatus;
}): Promise<WorkItem[]> {
  let ids: string[] = [];

  if (filters.assignee && filters.status) {
    // Intersection
    const byAssignee = await redis.smembers(WORKITEMS_IDX_ASSIGNEE + filters.assignee);
    const byStatus = await redis.smembers(WORKITEMS_IDX_STATUS + filters.status);
    const statusSet = new Set(byStatus);
    ids = byAssignee.filter(id => statusSet.has(id));
  } else if (filters.assignee) {
    ids = await redis.smembers(WORKITEMS_IDX_ASSIGNEE + filters.assignee);
  } else if (filters.status) {
    ids = await redis.smembers(WORKITEMS_IDX_STATUS + filters.status);
  } else {
    // All: union of pending + done
    const pending = await redis.smembers(WORKITEMS_IDX_STATUS + "pending");
    const done = await redis.smembers(WORKITEMS_IDX_STATUS + "done");
    ids = [...pending, ...done];
  }

  const items = await Promise.all(ids.map(id => loadWorkItem(id)));
  return items.filter((wi): wi is WorkItem => wi !== null);
}

// Find workflows triggered by a given event type and create cases for each match.
export async function processEvent(
  eventType: string,
  subject: string,
  payload: Record<string, unknown>,
): Promise<Case[]> {
  // Scan all workflow keys
  const keys = await redis.keys(WORKFLOW_KEY_PREFIX + "*");
  const cases: Case[] = [];

  for (const key of keys) {
    const raw = await redis.get(key);
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
