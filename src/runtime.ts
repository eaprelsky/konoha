import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { redis } from "./redis";
import { getWorkflow, WORKFLOW_INDEX_KEY, type WorkflowDefinition, type WorkflowElement } from "./workflow-loader";
import { getAdapter } from "./adapters/index";

// --- Event log ---

const EVENTS_LOG_KEY = "konoha:events:log"; // Redis stream for structured runtime events
const EVENTS_LOG_MAX_LEN = 10000;           // trim to last 10k events

export interface RuntimeEvent {
  id?: string;         // stream entry id (set on read)
  type: string;        // e.g. "case.created", "step.started"
  case_id?: string;
  process_id?: string;
  work_item_id?: string;
  element_id?: string;
  label?: string;
  timestamp: string;
}

async function emitEvent(event: Omit<RuntimeEvent, "id">): Promise<void> {
  const fields: Record<string, string> = { type: event.type, timestamp: event.timestamp };
  if (event.case_id)      fields.case_id = event.case_id;
  if (event.process_id)   fields.process_id = event.process_id;
  if (event.work_item_id) fields.work_item_id = event.work_item_id;
  if (event.element_id)   fields.element_id = event.element_id;
  if (event.label)        fields.label = event.label;
  await redis.xadd(EVENTS_LOG_KEY, "MAXLEN", "~", EVENTS_LOG_MAX_LEN, "*", ...Object.entries(fields).flat());
}

export async function listEvents(filters: {
  type?: string;
  after?: string;  // stream ID or ISO timestamp (converted to ms)
  before?: string; // stream ID or ISO timestamp
  limit?: number;
}): Promise<RuntimeEvent[]> {
  const limit = Math.min(filters.limit ?? 100, 1000);

  // Convert ISO dates to Redis stream IDs (ms timestamps)
  function toStreamId(s: string): string {
    if (/^\d+-\d+$/.test(s) || /^\d+$/.test(s)) return s; // already a stream ID
    const ms = new Date(s).getTime();
    return isNaN(ms) ? "-" : String(ms);
  }

  const start = filters.after ? toStreamId(filters.after) : "-";
  const end   = filters.before ? toStreamId(filters.before) : "+";

  const entries = await redis.xrange(EVENTS_LOG_KEY, start, end, "COUNT", limit) as [string, string[]][];
  const result: RuntimeEvent[] = [];
  for (const [entryId, fields] of entries) {
    const obj: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
    const event: RuntimeEvent = { id: entryId, type: obj.type, timestamp: obj.timestamp };
    if (obj.case_id)      event.case_id = obj.case_id;
    if (obj.process_id)   event.process_id = obj.process_id;
    if (obj.work_item_id) event.work_item_id = obj.work_item_id;
    if (obj.element_id)   event.element_id = obj.element_id;
    if (obj.label)        event.label = obj.label;
    if (!filters.type || event.type === filters.type) result.push(event);
  }
  return result;
}

const CASE_KEY_PREFIX = "case:";
const WORKITEM_KEY_PREFIX = "workitem:";
const WORKITEMS_IDX_ASSIGNEE = "konoha:workitems:assignee:"; // set of workitem IDs
const WORKITEMS_IDX_STATUS = "konoha:workitems:status:";    // set of workitem IDs
const WORKITEMS_IDX_PROCESS = "konoha:workitems:process:";  // set of workitem IDs per process_id
const WORKITEMS_IDX_ALL = "konoha:workitems:all";           // sorted set: work_item_id → created_at ms
const WORKFLOW_KEY_PREFIX = "workflow:";
const CASES_IDX_ALL = "konoha:cases:all";                   // sorted set: case_id → created_at ms
const CASES_IDX_STATUS = "konoha:cases:status:";            // set of case IDs per status
const CASES_IDX_PROCESS = "konoha:cases:process:";          // set of case IDs per process_id
const REMINDER_KEY_PREFIX = "reminder:";
const REMINDERS_IDX_ALL = "konoha:reminders:all";           // sorted set: reminder_id → scheduled_at ms
const REMINDERS_IDX_STATUS = "konoha:reminders:status:";    // set of reminder IDs per status

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

export interface ActiveBranch {
  element_id: string;      // function element id for this branch
  work_item_id: string;   // pending work item
  done: boolean;
}

export interface Case {
  case_id: string;
  process_id: string;
  process_version: string;
  subject: string;
  status: CaseStatus;
  position: string;             // current element id (gateway id when in parallel wait)
  active_branches?: ActiveBranch[]; // set during AND/OR gateway parallel execution
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

export type ReminderStatus = "pending" | "sent" | "acknowledged" | "overdue";
export type ReminderChannel = "gui" | "telegram" | "email";
export type ReminderType = "standalone" | "process-bound";

export interface Reminder {
  reminder_id: string;
  type: ReminderType;
  recipient: string;           // role, agent name, or user handle
  message: string;
  scheduled_at: string;        // ISO 8601
  channel: ReminderChannel;
  status: ReminderStatus;
  // process-bound context (optional)
  case_id?: string;
  process_id?: string;
  element_id?: string;
  created_at: string;
  updated_at: string;
}

// --- Helpers ---

async function saveCase(c: Case): Promise<void> {
  await redis.set(CASE_KEY_PREFIX + c.case_id, JSON.stringify(c));
  // Maintain indexes (idempotent — always re-sync)
  await redis.zadd(CASES_IDX_ALL, new Date(c.created_at).getTime(), c.case_id);
  // Remove from all status sets then add to current (handles status transitions)
  const allStatuses: CaseStatus[] = ["running", "done", "error"];
  for (const s of allStatuses) {
    if (s !== c.status) await redis.srem(CASES_IDX_STATUS + s, c.case_id);
  }
  await redis.sadd(CASES_IDX_STATUS + c.status, c.case_id);
  await redis.sadd(CASES_IDX_PROCESS + c.process_id, c.case_id);
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
  edgeConditions: Map<string, string>; // "from->to" => condition expression
} {
  const byId = new Map<string, WorkflowElement>(def.elements.map(e => [e.id, e]));
  const outEdges = new Map<string, string[]>();
  const inEdges = new Map<string, string[]>();
  const edgeConditions = new Map<string, string>();
  for (const el of def.elements) {
    outEdges.set(el.id, []);
    inEdges.set(el.id, []);
  }
  for (const edge of def.flow) {
    const [from, to, condition] = edge;
    outEdges.get(from)?.push(to);
    inEdges.get(to)?.push(from);
    if (condition) edgeConditions.set(`${from}->${to}`, condition);
  }
  return { outEdges, inEdges, byId, edgeConditions };
}

// Safely evaluate a condition expression against case payload.
// Supports: payload.<field> <op> <literal>
// Operators: ===, !==, >, <, >=, <=
// Literals: string ('x' or "x"), number, boolean (true/false), null
function evalCondition(condition: string, payload: Record<string, unknown>): boolean {
  const expr = condition.trim();
  const match = expr.match(
    /^payload\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(===|!==|>=|<=|>|<)\s*(.+)$/,
  );
  if (!match) return false;

  const [, field, op, rawValue] = match;
  const left = payload[field];

  // Parse right-hand side literal
  let right: unknown;
  const val = rawValue.trim();
  if (val === "true")            right = true;
  else if (val === "false")      right = false;
  else if (val === "null")       right = null;
  else if (val === "undefined")  right = undefined;
  else if (/^-?\d+(\.\d+)?$/.test(val)) right = Number(val);
  else if ((val.startsWith("'") && val.endsWith("'")) ||
           (val.startsWith('"') && val.endsWith('"'))) {
    right = val.slice(1, -1);
  } else {
    return false; // unknown literal — reject
  }

  switch (op) {
    case "===": return left === right;
    case "!==": return left !== right;
    case ">":   return typeof left === "number" && typeof right === "number" && left > right;
    case "<":   return typeof left === "number" && typeof right === "number" && left < right;
    case ">=":  return typeof left === "number" && typeof right === "number" && left >= right;
    case "<=":  return typeof left === "number" && typeof right === "number" && left <= right;
    default:    return false;
  }
}

// Find the join gateway that all parallel branches converge into.
// Returns the first gateway reachable from ALL branch start elements.
function findJoinGateway(
  branchIds: string[],
  outEdges: Map<string, string[]>,
  byId: Map<string, WorkflowElement>,
): string | null {
  // BFS forward from each branch to build reachable sets
  const reachableSets = branchIds.map(startId => {
    const visited = new Set<string>();
    const queue = [startId];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      for (const next of outEdges.get(id) || []) queue.push(next);
    }
    return visited;
  });

  if (reachableSets.length === 0) return null;

  // Find the first gateway reachable from ALL branches
  for (const candidate of reachableSets[0]) {
    const el = byId.get(candidate);
    if (el?.type === "gateway" && reachableSets.every(r => r.has(candidate))) {
      return candidate;
    }
  }
  return null;
}

// Helper: create a work item for a function element in a case
async function createWorkItemForElement(
  kase: Case,
  elementId: string,
  el: WorkflowElement,
): Promise<WorkItem> {
  const now = new Date().toISOString();
  const wi: WorkItem = {
    work_item_id: randomUUID(),
    case_id: kase.case_id,
    process_id: kase.process_id,
    element_id: elementId,
    label: el.label,
    assignee: el.role || "unassigned",
    status: "pending",
    input: kase.payload,
    created_at: now,
    updated_at: now,
  };
  await saveWorkItem(wi);
  await emitEvent({ type: "step.started", case_id: kase.case_id, process_id: kase.process_id, work_item_id: wi.work_item_id, element_id: elementId, label: el.label, timestamp: now });
  return wi;
}

// --- Core advance logic (AND/OR/XOR gateway support) ---

async function advanceCase(kase: Case, def: WorkflowDefinition): Promise<Case> {
  const { outEdges, byId, edgeConditions } = buildAdjacency(def);

  let current = kase.position;
  // When a gateway redirects flow (XOR split/join), forcedNextId is processed directly
  // instead of computing the next element from outEdges.get(current). This ensures the
  // redirect target is itself processed (not its successors), fixing the XOR skip bug.
  let forcedNextId: string | null = null;

  // Advance until we hit a function (create work item and stop) or a terminal event (close case)
  while (true) {
    let nextId: string;
    if (forcedNextId !== null) {
      nextId = forcedNextId;
      forcedNextId = null;
    } else {
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

      nextId = nexts[0];
    }

    const nextEl = byId.get(nextId);
    if (!nextEl) {
      kase.status = "error";
      await saveCase(kase);
      return kase;
    }

    if (nextEl.type === "function") {
      // Create work item and stop
      const wi = await createWorkItemForElement(kase, nextId, nextEl);

      kase.position = nextId;
      kase.history.push({
        element_id: nextId,
        element_type: "function",
        label: nextEl.label,
        timestamp: wi.created_at,
        work_item_id: wi.work_item_id,
      });
      await saveCase(kase);

      // Auto-execute via adapters (systems array; legacy system string already normalized on load)
      const systemBindings = nextEl.systems ?? (nextEl.system ? [{ connector: nextEl.system, operation: "default" }] : []);
      if (systemBindings.length > 0) {
        const labelSlug = nextEl.label.toLowerCase().replace(/\s+/g, "_");
        let mergedOutput: Record<string, unknown> = {};
        let adapterError = false;

        for (const binding of systemBindings) {
          const adapter = getAdapter(binding.connector);
          if (!adapter) continue;
          try {
            const op = (binding.operation && binding.operation !== "default") ? binding.operation : labelSlug;
            const out = await adapter.execute(op, kase.payload);
            mergedOutput = { ...mergedOutput, ...out };
          } catch (e: any) {
            console.error(`[runtime] adapter "${binding.connector}" error for "${nextEl.label}":`, e.message);
            adapterError = true;
            break;
          }
        }

        if (adapterError) {
          wi.status = "error";
          wi.updated_at = new Date().toISOString();
          await saveWorkItem(wi, "pending");
          kase.status = "error";
          await saveCase(kase);
          return kase;
        }

        if (Object.keys(mergedOutput).length > 0 || systemBindings.some(b => getAdapter(b.connector))) {
          // All adapters executed — complete the work item and advance
          const prevStatus = wi.status;
          wi.status = "done";
          wi.output = mergedOutput;
          wi.updated_at = new Date().toISOString();
          await saveWorkItem(wi, prevStatus);
          const histEntry = kase.history.find(h => h.work_item_id === wi.work_item_id);
          if (histEntry) histEntry.output = mergedOutput;
          current = nextId;
          continue; // advance past the completed function
        }
      }

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

    if (nextEl.type === "gateway") {
      const operator = nextEl.operator;
      const gwOuts = outEdges.get(nextId) || [];

      // --- XOR split ---
      if (operator === "XOR") {
        // Record passage
        const gwTs = new Date().toISOString();
        kase.history.push({ element_id: nextId, element_type: "gateway", label: nextEl.label, timestamp: gwTs });
        kase.position = nextId;
        await emitEvent({ type: "gateway.evaluated", case_id: kase.case_id, process_id: kase.process_id, element_id: nextId, label: nextEl.label, timestamp: gwTs });

        // XOR join: single incoming branch passes through
        if (gwOuts.length <= 1) {
          if (gwOuts.length === 0) { kase.status = "error"; await saveCase(kase); return kase; }
          // Use forcedNextId so the successor is processed as nextEl (not skipped)
          current = nextId;
          forcedNextId = gwOuts[0];
          continue;
        }

        // XOR split: take first branch whose condition is true (or first unconditional)
        let takenBranch: string | null = null;
        for (const outId of gwOuts) {
          const cond = edgeConditions.get(`${nextId}->${outId}`);
          if (!cond || evalCondition(cond, kase.payload)) {
            takenBranch = outId;
            break;
          }
        }
        if (!takenBranch) { kase.status = "error"; await saveCase(kase); return kase; }
        await saveCase(kase);
        // Use forcedNextId so takenBranch is processed as nextEl (not its successors)
        current = nextId;
        forcedNextId = takenBranch;
        continue;
      }

      // --- AND split / OR split ---
      if (operator === "AND" || operator === "OR") {
        // Determine active branches
        let activeBranchIds: string[];
        if (operator === "AND") {
          activeBranchIds = gwOuts; // all branches
        } else {
          // OR: take branches whose condition is true (or unconditional)
          activeBranchIds = gwOuts.filter(outId => {
            const cond = edgeConditions.get(`${nextId}->${outId}`);
            return !cond || evalCondition(cond, kase.payload);
          });
          if (activeBranchIds.length === 0) { kase.status = "error"; await saveCase(kase); return kase; }
        }

        // For each active branch: advance to first function, create work item
        const branches: ActiveBranch[] = [];
        for (const branchStartId of activeBranchIds) {
          // Walk forward from branchStart to find the first function (skip intermediate events)
          let branchEl = byId.get(branchStartId);
          let branchElId = branchStartId;
          // Follow event chain until function
          while (branchEl?.type === "event") {
            kase.history.push({ element_id: branchElId, element_type: "event", label: branchEl.label, timestamp: new Date().toISOString() });
            const nextsOfBranch = outEdges.get(branchElId) || [];
            if (nextsOfBranch.length === 0) break;
            branchElId = nextsOfBranch[0];
            branchEl = byId.get(branchElId);
          }
          if (branchEl?.type !== "function") continue; // skip non-function branch endpoints

          const wi = await createWorkItemForElement(kase, branchElId, branchEl);
          kase.history.push({ element_id: branchElId, element_type: "function", label: branchEl.label, timestamp: wi.created_at, work_item_id: wi.work_item_id });

          // Auto-execute via adapters (systems array; legacy system string already normalized on load)
          const branchBindings = branchEl.systems ?? (branchEl.system ? [{ connector: branchEl.system, operation: "default" }] : []);
          if (branchBindings.length > 0) {
            const labelSlug = branchEl.label.toLowerCase().replace(/\s+/g, "_");
            let mergedOut: Record<string, unknown> = {};
            let branchErr = false;
            for (const binding of branchBindings) {
              const adapter = getAdapter(binding.connector);
              if (!adapter) continue;
              try {
                const op = (binding.operation && binding.operation !== "default") ? binding.operation : labelSlug;
                const out = await adapter.execute(op, kase.payload);
                mergedOut = { ...mergedOut, ...out };
              } catch (e: any) {
                console.error(`[runtime] adapter error in branch "${branchElId}":`, e.message);
                branchErr = true;
                break;
              }
            }
            if (!branchErr && branchBindings.some(b => getAdapter(b.connector))) {
              wi.status = "done"; wi.output = mergedOut; wi.updated_at = new Date().toISOString();
              await saveWorkItem(wi, "pending");
              const h = kase.history.find(h => h.work_item_id === wi.work_item_id);
              if (h) h.output = mergedOut;
              branches.push({ element_id: branchElId, work_item_id: wi.work_item_id, done: true });
              continue;
            }
          }
          branches.push({ element_id: branchElId, work_item_id: wi.work_item_id, done: false });
        }

        kase.position = nextId; // at the split gateway
        kase.active_branches = branches;
        kase.history.push({ element_id: nextId, element_type: "gateway", label: `${operator} split (${branches.length} branches)`, timestamp: new Date().toISOString() });
        await saveCase(kase);

        // If all branches auto-completed (adapters), advance past join
        if (branches.every(b => b.done)) {
          return advancePastJoin(kase, def, branches.map(b => b.element_id));
        }
        return kase;
      }

      // Unknown gateway operator
      kase.status = "error";
      await saveCase(kase);
      return kase;
    }

    // Unknown element type
    kase.status = "error";
    await saveCase(kase);
    return kase;
  }
}

// Advance past the join gateway after all parallel branches completed.
async function advancePastJoin(kase: Case, def: WorkflowDefinition, branchElementIds: string[]): Promise<Case> {
  const { outEdges, byId } = buildAdjacency(def);
  const joinId = findJoinGateway(branchElementIds, outEdges, byId);

  kase.active_branches = undefined;
  kase.history.push({ element_id: joinId || "(join)", element_type: "gateway", label: "join", timestamp: new Date().toISOString() });

  if (!joinId) {
    kase.status = "error";
    await saveCase(kase);
    return kase;
  }

  kase.position = joinId;
  await saveCase(kase);
  return advanceCase(kase, def);
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
  await emitEvent({ type: "case.created", case_id: kase.case_id, process_id: kase.process_id, timestamp: kase.created_at });

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
  await emitEvent({
    type: "step.completed",
    case_id: wi.case_id ?? undefined,
    process_id: wi.process_id ?? undefined,
    work_item_id: wi.work_item_id,
    element_id: wi.element_id ?? undefined,
    label: wi.label,
    timestamp: wi.updated_at,
  });

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

  // --- Parallel branch handling (AND/OR join) ---
  if (kase.active_branches && kase.active_branches.length > 0) {
    const branch = kase.active_branches.find(b => b.work_item_id === work_item_id);
    if (branch) {
      branch.done = true;
      await saveCase(kase);

      if (kase.active_branches.every(b => b.done)) {
        // All branches done — advance past join gateway
        const updatedCase = await advancePastJoin(kase, def, kase.active_branches.map(b => b.element_id));
        return { workItem: wi, case: updatedCase };
      }
      // Still waiting for other branches
      return { workItem: wi, case: kase };
    }
  }

  // --- Linear advance ---
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
  // Use index set instead of KEYS scan to avoid O(N) blocking on Redis
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

export async function listCases(filters: {
  status?: CaseStatus;
  process_id?: string;
  after?: string;   // ISO 8601 — created_at >=
  before?: string;  // ISO 8601 — created_at <=
  limit?: number;
  offset?: number;
}): Promise<{ cases: Case[]; total: number }> {
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
  if (!candidateIds) {
    // No index filter — get all from sorted set (ordered by created_at)
    const all = await redis.zrange(CASES_IDX_ALL, 0, -1);
    candidateIds = new Set(all);
  }

  const cases = await Promise.all([...candidateIds].map(id => loadCase(id)));
  let result = cases.filter((c): c is Case => c !== null);

  // In-memory date range filter
  if (filters.after) {
    const after = new Date(filters.after).getTime();
    result = result.filter(c => new Date(c.created_at).getTime() >= after);
  }
  if (filters.before) {
    const before = new Date(filters.before).getTime();
    result = result.filter(c => new Date(c.created_at).getTime() <= before);
  }

  result.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  const total = result.length;
  const offset = filters.offset ?? 0;
  const limit = filters.limit ?? 50;
  const page = result.slice(offset, offset + limit);

  return { cases: page, total };
}

// --- Reminders ---

async function saveReminder(r: Reminder, prevStatus?: ReminderStatus): Promise<void> {
  await redis.set(REMINDER_KEY_PREFIX + r.reminder_id, JSON.stringify(r));
  if (prevStatus && prevStatus !== r.status) {
    await redis.srem(REMINDERS_IDX_STATUS + prevStatus, r.reminder_id);
  }
  await redis.sadd(REMINDERS_IDX_STATUS + r.status, r.reminder_id);
  await redis.zadd(REMINDERS_IDX_ALL, new Date(r.scheduled_at).getTime(), r.reminder_id);
}

async function loadReminder(reminder_id: string): Promise<Reminder | null> {
  const raw = await redis.get(REMINDER_KEY_PREFIX + reminder_id);
  return raw ? JSON.parse(raw) : null;
}

export async function createReminder(params: {
  type: ReminderType;
  recipient: string;
  message: string;
  scheduled_at: string;
  channel: ReminderChannel;
  case_id?: string;
  process_id?: string;
  element_id?: string;
}): Promise<Reminder> {
  const now = new Date().toISOString();
  const r: Reminder = {
    reminder_id: randomUUID(),
    type: params.type,
    recipient: params.recipient,
    message: params.message,
    scheduled_at: params.scheduled_at,
    channel: params.channel,
    status: "pending",
    case_id: params.case_id,
    process_id: params.process_id,
    element_id: params.element_id,
    created_at: now,
    updated_at: now,
  };
  await saveReminder(r);
  return r;
}

export async function listReminders(filters: {
  status?: ReminderStatus;
  recipient?: string;
} = {}): Promise<Reminder[]> {
  let ids: string[];
  if (filters.status) {
    ids = await redis.smembers(REMINDERS_IDX_STATUS + filters.status);
  } else {
    ids = await redis.zrange(REMINDERS_IDX_ALL, 0, -1);
  }
  const reminders = await Promise.all(ids.map(id => loadReminder(id)));
  let result = reminders.filter((r): r is Reminder => r !== null);
  if (filters.recipient) {
    result = result.filter(r => r.recipient === filters.recipient);
  }
  result.sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime());
  return result;
}

export async function updateReminderStatus(
  reminder_id: string,
  status: ReminderStatus,
): Promise<Reminder> {
  const r = await loadReminder(reminder_id);
  if (!r) throw new Error(`Reminder "${reminder_id}" not found`);
  const prev = r.status;
  r.status = status;
  r.updated_at = new Date().toISOString();
  await saveReminder(r, prev);
  return r;
}

export async function deleteReminder(reminder_id: string): Promise<void> {
  const r = await loadReminder(reminder_id);
  if (!r) throw new Error(`Reminder "${reminder_id}" not found`);
  await redis.del(REMINDER_KEY_PREFIX + reminder_id);
  await redis.srem(REMINDERS_IDX_STATUS + r.status, reminder_id);
  await redis.zrem(REMINDERS_IDX_ALL, reminder_id);
}

// Scheduler: check every 60s, mark overdue/sent pending reminders
export function startReminderScheduler(): void {
  setInterval(async () => {
    try {
      const pending = await listReminders({ status: "pending" });
      const now = new Date();
      for (const r of pending) {
        const scheduled = new Date(r.scheduled_at);
        if (scheduled <= now) {
          // Mark as sent (actual delivery is channel-specific; GUI channel = mark sent)
          await updateReminderStatus(r.reminder_id, "sent");
          if (r.channel === "telegram") {
            // Resolve recipient name → telegram_id from trusted-users
            try {
              const trustedUsers = JSON.parse(readFileSync("/opt/shared/.trusted-users.json", "utf-8"));
              const allUsers = [trustedUsers.owner, ...(trustedUsers.trusted ?? [])];
              const recipientClean = r.recipient.replace(/^@/, "");
              const user = allUsers.find((u: { name: string; username?: string; telegram_id: number }) =>
                u.name === r.recipient ||
                u.username === recipientClean ||
                String(u.telegram_id) === r.recipient
              );
              if (user) {
                await redis.xadd(
                  "telegram:outgoing",
                  "*",
                  "chat_id",
                  String(user.telegram_id),
                  "text",
                  `[Напоминание] ${r.message}`,
                ).catch(() => {});
              }
            } catch (_) {}
          }
        }
      }
      // Mark sent reminders older than 24h without ack as overdue
      const sent = await listReminders({ status: "sent" });
      const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      for (const r of sent) {
        if (new Date(r.scheduled_at) < oneDayAgo) {
          await updateReminderStatus(r.reminder_id, "overdue").catch(() => {});
        }
      }
    } catch (_) {}
  }, 60_000);
}

// --- Roles Directory ---

const ROLE_KEY_PREFIX = "role:";
const ROLES_IDX_ALL = "konoha:roles:all";

export type AssignmentStrategy = "round-robin" | "load-balancing" | "broadcast" | "manual";

export interface RoleDef {
  role_id: string;
  name: string;
  description?: string;
  assignees: string[];          // agent IDs or user handles
  strategy: AssignmentStrategy;
  created_at: string;
  updated_at: string;
}

async function saveRole(r: RoleDef): Promise<void> {
  await redis.set(ROLE_KEY_PREFIX + r.role_id, JSON.stringify(r));
  await redis.zadd(ROLES_IDX_ALL, new Date(r.created_at).getTime(), r.role_id);
}

async function loadRole(role_id: string): Promise<RoleDef | null> {
  const raw = await redis.get(ROLE_KEY_PREFIX + role_id);
  return raw ? JSON.parse(raw) : null;
}

export async function createRole(params: Omit<RoleDef, "created_at" | "updated_at">): Promise<RoleDef> {
  const now = new Date().toISOString();
  const r: RoleDef = { ...params, created_at: now, updated_at: now };
  await saveRole(r);
  return r;
}

export async function listRoles(): Promise<RoleDef[]> {
  const ids = await redis.zrange(ROLES_IDX_ALL, 0, -1);
  const roles = await Promise.all(ids.map(id => loadRole(id)));
  return roles.filter((r): r is RoleDef => r !== null);
}

export async function updateRole(role_id: string, patch: Partial<Pick<RoleDef, "name" | "description" | "assignees" | "strategy">>): Promise<RoleDef> {
  const r = await loadRole(role_id);
  if (!r) throw new Error(`Role "${role_id}" not found`);
  if (patch.name !== undefined)        r.name = patch.name;
  if (patch.description !== undefined) r.description = patch.description;
  if (patch.assignees !== undefined)   r.assignees = patch.assignees;
  if (patch.strategy !== undefined)    r.strategy = patch.strategy;
  r.updated_at = new Date().toISOString();
  await saveRole(r);
  return r;
}

export async function deleteRole(role_id: string): Promise<void> {
  await redis.del(ROLE_KEY_PREFIX + role_id);
  await redis.zrem(ROLES_IDX_ALL, role_id);
}

// --- Documents Directory ---

const DOC_KEY_PREFIX = "doc:";
const DOCS_IDX_ALL = "konoha:docs:all";

export type DocType = "prompt" | "instruction" | "form" | "template" | "attachment";

export interface DocTemplate {
  doc_id: string;
  name: string;
  type: DocType;
  content: string;             // template text with {{placeholder}} syntax
  parameters: string[];        // auto-extracted parameter names
  created_at: string;
  updated_at: string;
}

function extractParameters(content: string): string[] {
  const matches = content.match(/\{\{(\w+)\}\}/g) || [];
  return [...new Set(matches.map(m => m.slice(2, -2)))];
}

async function saveDoc(d: DocTemplate): Promise<void> {
  d.parameters = extractParameters(d.content);
  await redis.set(DOC_KEY_PREFIX + d.doc_id, JSON.stringify(d));
  await redis.zadd(DOCS_IDX_ALL, new Date(d.created_at).getTime(), d.doc_id);
}

async function loadDoc(doc_id: string): Promise<DocTemplate | null> {
  const raw = await redis.get(DOC_KEY_PREFIX + doc_id);
  return raw ? JSON.parse(raw) : null;
}

export async function createDoc(params: { name: string; type: DocType; content: string }): Promise<DocTemplate> {
  const now = new Date().toISOString();
  const d: DocTemplate = {
    doc_id: randomUUID(),
    name: params.name,
    type: params.type,
    content: params.content,
    parameters: extractParameters(params.content),
    created_at: now,
    updated_at: now,
  };
  await saveDoc(d);
  return d;
}

export async function listDocs(): Promise<DocTemplate[]> {
  const ids = await redis.zrange(DOCS_IDX_ALL, 0, -1);
  const docs = await Promise.all(ids.map(id => loadDoc(id)));
  return docs.filter((d): d is DocTemplate => d !== null);
}

export async function updateDoc(doc_id: string, patch: Partial<Pick<DocTemplate, "name" | "type" | "content">>): Promise<DocTemplate> {
  const d = await loadDoc(doc_id);
  if (!d) throw new Error(`Document "${doc_id}" not found`);
  if (patch.name !== undefined)    d.name = patch.name;
  if (patch.type !== undefined)    d.type = patch.type;
  if (patch.content !== undefined) d.content = patch.content;
  d.updated_at = new Date().toISOString();
  await saveDoc(d);
  return d;
}

export async function deleteDoc(doc_id: string): Promise<void> {
  await redis.del(DOC_KEY_PREFIX + doc_id);
  await redis.zrem(DOCS_IDX_ALL, doc_id);
}
