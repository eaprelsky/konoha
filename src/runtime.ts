import { randomUUID } from "crypto";
import { redis } from "./redis";
import { getWorkflow, type WorkflowDefinition, type WorkflowElement } from "./workflow-loader";

const CASE_KEY_PREFIX = "case:";
const WORKITEM_KEY_PREFIX = "workitem:";
const WORKITEMS_IDX_ASSIGNEE = "konoha:workitems:assignee:"; // set of workitem IDs
const WORKITEMS_IDX_STATUS = "konoha:workitems:status:";    // set of workitem IDs
const WORKITEMS_IDX_PROCESS = "konoha:workitems:process:";  // set of workitem IDs per process_id
const WORKITEMS_IDX_ALL = "konoha:workitems:all";           // sorted set: work_item_id → created_at ms
const WORKFLOW_KEY_PREFIX = "workflow:";

// --- Types ---

export type CaseStatus = "running" | "done" | "error";
export type WorkItemStatus = "pending" | "running" | "done" | "cancelled" | "error";

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
  case_id: string | null;      // null for standalone items
  process_id: string | null;   // null for standalone items
  element_id: string | null;   // null for standalone items
  label: string;
  assignee: string;
  status: WorkItemStatus;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  deadline?: string;           // ISO 8601 optional deadline
  created_at: string;
  updated_at: string;
}

// --- Helpers ---

async function saveCase(c: Case): Promise<void> {
  await redis.set(CASE_KEY_PREFIX + c.case_id, JSON.stringify(c));
}

async function loadCase(case_id: string): Promise<Case | null> {
  const raw = await redis.get(CASE_KEY_PREFIX + case_id);
  return raw ? JSON.parse(raw) : null;
}

async function saveWorkItem(wi: WorkItem, prevStatus?: WorkItemStatus, prevAssignee?: string): Promise<void> {
  await redis.set(WORKITEM_KEY_PREFIX + wi.work_item_id, JSON.stringify(wi));

  // Update assignee index (handle reassignment)
  if (prevAssignee && prevAssignee !== wi.assignee) {
    await redis.srem(WORKITEMS_IDX_ASSIGNEE + prevAssignee, wi.work_item_id);
  }
  await redis.sadd(WORKITEMS_IDX_ASSIGNEE + wi.assignee, wi.work_item_id);

  // Update status index (remove from old status set)
  if (prevStatus && prevStatus !== wi.status) {
    await redis.srem(WORKITEMS_IDX_STATUS + prevStatus, wi.work_item_id);
  }
  await redis.sadd(WORKITEMS_IDX_STATUS + wi.status, wi.work_item_id);

  // process_id index
  if (wi.process_id) {
    await redis.sadd(WORKITEMS_IDX_PROCESS + wi.process_id, wi.work_item_id);
  }

  // global sorted set (score = created_at ms for ordering)
  await redis.zadd(WORKITEMS_IDX_ALL, new Date(wi.created_at).getTime(), wi.work_item_id);
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
      const now = new Date().toISOString();
      const wi: WorkItem = {
        work_item_id,
        case_id: kase.case_id,
        process_id: kase.process_id,
        element_id: nextId,
        label: nextEl.label,
        assignee: nextEl.role || "unassigned",
        status: "pending",
        input: kase.payload,
        created_at: now,
        updated_at: now,
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

  // Standalone work item — no case to advance
  if (!wi.case_id) {
    return { workItem: wi, case: null };
  }

  const kase = await loadCase(wi.case_id);
  if (!kase) throw new Error(`Case "${wi.case_id}" not found`);

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
  process_id?: string;
  deadline_before?: string;
}): Promise<WorkItem[]> {
  // Build candidate set using the most selective index first
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
    // No index filter — get all from sorted set
    const all = await redis.zrange(WORKITEMS_IDX_ALL, 0, -1);
    candidateIds = new Set(all);
  }

  const items = await Promise.all([...candidateIds].map(id => loadWorkItem(id)));
  let result = items.filter((wi): wi is WorkItem => wi !== null);

  // In-memory filter for deadline_before (range query)
  if (filters.deadline_before) {
    const cutoff = new Date(filters.deadline_before).getTime();
    result = result.filter(wi => wi.deadline && new Date(wi.deadline).getTime() <= cutoff);
  }

  return result.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
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
