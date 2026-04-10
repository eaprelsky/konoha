/**
 * cases.ts — Case lifecycle management + work item advancement helpers.
 * Extracted from runtime.ts (issue #338).
 *
 * saveWorkItem/loadWorkItem/pgRowToWorkItem are exported so work-items.ts
 * can reuse them without creating a circular dependency.
 */
import { randomUUID } from "crypto";
import { redis } from "../redis";
import { publishEvent } from "../redis";
import { getWorkflow, WORKFLOW_INDEX_KEY, type WorkflowDefinition, type WorkflowElement } from "../workflow-loader";
import { getAdapter } from "../adapters/index";
import { dispatchWorkItem } from "../dispatcher";
import { createSubscriptionProgrammatic, cancelSubscriptionsByInstance, type TriggerDef } from "../event-manager";
import {
  pgUpsertCase, pgUpsertWorkItem, pgDeleteWorkItem,
  pgGetCase, pgListCases,
  pgGetWorkItem, pgListWorkItems,
} from "../storage/pg";
import { emitEvent } from "./event-log";
import { createLogger } from "../logger";

const log = createLogger("runtime:cases");
const PG_READ = process.env.PG_READ === "true";

// ── Redis key prefixes ────────────────────────────────────────────────────────

export const CASE_KEY_PREFIX = "case:";
export const WORKITEM_KEY_PREFIX = "workitem:";
export const WORKITEMS_IDX_ASSIGNEE = "konoha:workitems:assignee:";
export const WORKITEMS_IDX_STATUS = "konoha:workitems:status:";
export const WORKITEMS_IDX_PROCESS = "konoha:workitems:process:";
export const WORKITEMS_IDX_ALL = "konoha:workitems:all";
const WORKFLOW_KEY_PREFIX = "workflow:";
const CASES_IDX_ALL = "konoha:cases:all";
const CASES_IDX_STATUS = "konoha:cases:status:";
const CASES_IDX_PROCESS = "konoha:cases:process:";

// ── Types ─────────────────────────────────────────────────────────────────────

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
  element_id: string;
  work_item_id: string;
  done: boolean;
}

export interface Case {
  case_id: string;
  process_id: string;
  process_version: string;
  subject: string;
  status: CaseStatus;
  position: string;
  active_branches?: ActiveBranch[];
  payload: Record<string, unknown>;
  history: HistoryEntry[];
  created_at: string;
}

export interface WorkItem {
  work_item_id: string;
  case_id: string | null;
  process_id: string | null;
  element_id: string | null;
  label: string;
  assignee: string;
  status: WorkItemStatus;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  deadline?: string;
  created_at: string;
  updated_at: string;
}

// ── PG row converters ─────────────────────────────────────────────────────────

function isoStr(v: unknown): string {
  if (!v) return new Date().toISOString();
  return v instanceof Date ? v.toISOString() : String(v);
}

function pgRowToCase(row: Record<string, unknown>): Case {
  const raw = (row.payload ?? {}) as Record<string, unknown>;
  const { __active_branches, ...cleanPayload } = raw;
  return {
    case_id: String(row.case_id),
    process_id: String(row.process_id),
    process_version: String(row.version ?? ''),
    subject: String(row.subject ?? ''),
    status: (row.status ?? 'running') as CaseStatus,
    position: String(row.position ?? ''),
    active_branches: Array.isArray(__active_branches) ? __active_branches as ActiveBranch[] : undefined,
    payload: cleanPayload,
    history: Array.isArray(row.history) ? row.history as HistoryEntry[] : [],
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
  const pgPayload = c.active_branches ? { ...c.payload, __active_branches: c.active_branches } : c.payload;
  pgUpsertCase({ case_id: c.case_id, process_id: c.process_id, version: c.process_version, subject: c.subject, status: c.status, position: c.position, payload: pgPayload, history: c.history, created_at: c.created_at, updated_at: new Date().toISOString() });
  await redis.zadd(CASES_IDX_ALL, new Date(c.created_at).getTime(), c.case_id);
  const allStatuses: CaseStatus[] = ["running", "done", "error"];
  for (const s of allStatuses) {
    if (s !== c.status) await redis.srem(CASES_IDX_STATUS + s, c.case_id);
  }
  await redis.sadd(CASES_IDX_STATUS + c.status, c.case_id);
  await redis.sadd(CASES_IDX_PROCESS + c.process_id, c.case_id);
}

export async function loadCase(case_id: string): Promise<Case | null> {
  if (PG_READ) {
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
  await redis.zadd(WORKITEMS_IDX_ALL, new Date(wi.created_at).getTime(), wi.work_item_id);
}

export async function loadWorkItem(work_item_id: string): Promise<WorkItem | null> {
  if (PG_READ) {
    const row = await pgGetWorkItem(work_item_id);
    return row ? pgRowToWorkItem(row) : null;
  }
  const raw = await redis.get(WORKITEM_KEY_PREFIX + work_item_id);
  return raw ? JSON.parse(raw) : null;
}

// ── Internal advancement helpers ──────────────────────────────────────────────

function buildAdjacency(def: WorkflowDefinition): {
  outEdges: Map<string, string[]>;
  inEdges: Map<string, string[]>;
  byId: Map<string, WorkflowElement>;
  edgeConditions: Map<string, string>;
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

function evalCondition(condition: string, payload: Record<string, unknown>): boolean {
  const expr = condition.trim();
  const match = expr.match(
    /^payload\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(===|!==|>=|<=|>|<)\s*(.+)$/,
  );
  if (!match) return false;
  const [, field, op, rawValue] = match;
  const left = payload[field];
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
    return false;
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

function findJoinGateway(
  branchIds: string[],
  outEdges: Map<string, string[]>,
  byId: Map<string, WorkflowElement>,
): string | null {
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
  for (const candidate of reachableSets[0]) {
    const el = byId.get(candidate);
    if (el?.type === "gateway" && reachableSets.every(r => r.has(candidate))) {
      return candidate;
    }
  }
  return null;
}

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
    input: {
      ...kase.payload,
      ...(el.intent ? { _intent: el.intent } : {}),
    },
    created_at: now,
    updated_at: now,
  };
  await saveWorkItem(wi);
  await emitEvent({ type: "step.started", case_id: kase.case_id, process_id: kase.process_id, work_item_id: wi.work_item_id, element_id: elementId, label: el.label, timestamp: now });
  return wi;
}

async function subscribeEventNode(kase: Case, el: WorkflowElement): Promise<void> {
  const trigger = el.trigger;
  if (!trigger?.kind || trigger.kind === "manual" || trigger.kind === "ambiguous" || trigger.manual_override) {
    return;
  }
  await createSubscriptionProgrammatic({
    event_id: el.id,
    process_id: kase.process_id,
    instance_id: kase.case_id,
    trigger: trigger as TriggerDef,
  });
}

export async function advanceCase(kase: Case, def: WorkflowDefinition): Promise<Case> {
  const { outEdges, inEdges, byId, edgeConditions } = buildAdjacency(def);

  let current = kase.position;
  let forcedNextId: string | null = null;

  while (true) {
    let nextId: string;
    if (forcedNextId !== null) {
      nextId = forcedNextId;
      forcedNextId = null;
    } else {
      const nexts = outEdges.get(current) || [];

      if (nexts.length === 0) {
        const el = byId.get(current);
        if (el?.type === "event") {
          kase.status = "done";
          kase.history.push({ element_id: current, element_type: "event", label: el.label, timestamp: new Date().toISOString() });
          await saveCase(kase);
          cancelSubscriptionsByInstance(kase.case_id).catch(e =>
            log.error("subscription cleanup error", { case_id: kase.case_id, error: e.message }),
          );
          return kase;
        }
        kase.status = "error";
        await saveCase(kase);
        cancelSubscriptionsByInstance(kase.case_id).catch(e =>
          log.error("subscription cleanup error", { case_id: kase.case_id, error: e.message }),
        );
        publishEvent({ type: "process.exception", source: "runtime@comind.konoha", village_id: "comind.konoha", timestamp: new Date().toISOString(), payload: { case_id: kase.case_id, process_id: kase.process_id, error: `unexpected terminal element: ${current}` } }).catch(() => {});
        return kase;
      }

      nextId = nexts[0];
    }

    const nextEl = byId.get(nextId);
    if (!nextEl) {
      kase.status = "error";
      await saveCase(kase);
      publishEvent({ type: "process.exception", source: "runtime@comind.konoha", village_id: "comind.konoha", timestamp: new Date().toISOString(), payload: { case_id: kase.case_id, process_id: kase.process_id, error: `element not found: ${nextId}` } }).catch(() => {});
      return kase;
    }

    if (nextEl.type === "function") {
      const wi = await createWorkItemForElement(kase, nextId, nextEl);

      kase.position = nextId;
      kase.history.push({ element_id: nextId, element_type: "function", label: nextEl.label, timestamp: wi.created_at, work_item_id: wi.work_item_id });
      await saveCase(kase);

      if (nextEl.role) {
        dispatchWorkItem({
          role: nextEl.role,
          label: nextEl.label,
          work_item_id: wi.work_item_id,
          case_id: kase.case_id,
          process_id: kase.process_id,
          element_id: nextId,
          docIds: nextEl.documents || [],
        }).catch(e => log.error("dispatch error", { case_id: kase.case_id, element_id: nextId, error: e.message }));
      }

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
            log.error("adapter error", { connector: binding.connector, label: nextEl.label, error: e.message });
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
          const prevStatus = wi.status;
          wi.status = "done";
          wi.output = mergedOutput;
          wi.updated_at = new Date().toISOString();
          await saveWorkItem(wi, prevStatus);
          const histEntry = kase.history.find(h => h.work_item_id === wi.work_item_id);
          if (histEntry) histEntry.output = mergedOutput;
          current = nextId;
          continue;
        }
      }

      return kase;
    }

    if (nextEl.type === "event") {
      kase.position = nextId;
      kase.history.push({ element_id: nextId, element_type: "event", label: nextEl.label, timestamp: new Date().toISOString() });

      const isIntermediate = (inEdges.get(nextId) || []).length > 0;
      const trigger = nextEl.trigger;
      if (isIntermediate && trigger?.kind && trigger.kind !== "manual" && trigger.kind !== "ambiguous" && !trigger.manual_override) {
        await saveCase(kase);
        subscribeEventNode(kase, nextEl).catch(e =>
          log.error("intermediate event subscribe error", { case_id: kase.case_id, node_id: nextId, error: e.message }),
        );
        return kase;
      }

      current = nextId;
      continue;
    }

    if (nextEl.type === "gateway") {
      const operator = nextEl.operator;
      const gwOuts = outEdges.get(nextId) || [];

      if (operator === "XOR") {
        const gwTs = new Date().toISOString();
        kase.history.push({ element_id: nextId, element_type: "gateway", label: nextEl.label, timestamp: gwTs });
        kase.position = nextId;
        await emitEvent({ type: "gateway.evaluated", case_id: kase.case_id, process_id: kase.process_id, element_id: nextId, label: nextEl.label, timestamp: gwTs });

        if (gwOuts.length <= 1) {
          if (gwOuts.length === 0) { kase.status = "error"; await saveCase(kase); return kase; }
          current = nextId;
          forcedNextId = gwOuts[0];
          continue;
        }

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
        current = nextId;
        forcedNextId = takenBranch;
        continue;
      }

      if (operator === "AND" || operator === "OR") {
        let activeBranchIds: string[];
        if (operator === "AND") {
          activeBranchIds = gwOuts;
        } else {
          activeBranchIds = gwOuts.filter(outId => {
            const cond = edgeConditions.get(`${nextId}->${outId}`);
            return !cond || evalCondition(cond, kase.payload);
          });
          if (activeBranchIds.length === 0) { kase.status = "error"; await saveCase(kase); return kase; }
        }

        const branches: ActiveBranch[] = [];
        for (const branchStartId of activeBranchIds) {
          let branchEl = byId.get(branchStartId);
          let branchElId = branchStartId;
          while (branchEl?.type === "event") {
            kase.history.push({ element_id: branchElId, element_type: "event", label: branchEl.label, timestamp: new Date().toISOString() });
            const nextsOfBranch = outEdges.get(branchElId) || [];
            if (nextsOfBranch.length === 0) break;
            branchElId = nextsOfBranch[0];
            branchEl = byId.get(branchElId);
          }
          if (branchEl?.type !== "function") continue;

          const wi = await createWorkItemForElement(kase, branchElId, branchEl);
          kase.history.push({ element_id: branchElId, element_type: "function", label: branchEl.label, timestamp: wi.created_at, work_item_id: wi.work_item_id });

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
                log.error("adapter error in branch", { element_id: branchElId, error: e.message });
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

        kase.position = nextId;
        kase.active_branches = branches;
        kase.history.push({ element_id: nextId, element_type: "gateway", label: `${operator} split (${branches.length} branches)`, timestamp: new Date().toISOString() });
        await saveCase(kase);

        if (branches.every(b => b.done)) {
          return advancePastJoin(kase, def, branches.map(b => b.element_id));
        }
        return kase;
      }

      kase.status = "error";
      await saveCase(kase);
      return kase;
    }

    kase.status = "error";
    await saveCase(kase);
    return kase;
  }
}

export async function advancePastJoin(kase: Case, def: WorkflowDefinition, branchElementIds: string[]): Promise<Case> {
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

// ── Public API ─────────────────────────────────────────────────────────────────

export async function createCase(
  process_id: string,
  subject: string,
  payload: Record<string, unknown> = {},
  start_node?: string,
): Promise<Case> {
  let def = await getWorkflow(process_id);
  if (!def) {
    await new Promise(r => setTimeout(r, 200));
    def = await getWorkflow(process_id);
  }
  if (!def) throw new Error(`Workflow "${process_id}" not found in registry`);

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
    history: [{ element_id: startId, element_type: startEl.type, label: startEl.label, timestamp: now }],
    created_at: now,
  };

  await saveCase(kase);
  await emitEvent({ type: "case.created", case_id: kase.case_id, process_id: kase.process_id, timestamp: kase.created_at });
  return advanceCase(kase, def);
}

export async function getCase(case_id: string): Promise<Case | null> {
  return loadCase(case_id);
}

export async function forceCloseCase(case_id: string): Promise<Case | null> {
  const kase = await loadCase(case_id);
  if (!kase) return null;
  if (kase.status !== "running") return kase;
  kase.status = "done";
  await saveCase(kase);
  cancelSubscriptionsByInstance(case_id).catch(() => {});
  return kase;
}

export async function processEvent(
  eventType: string,
  subject: string,
  payload: Record<string, unknown>,
): Promise<Case[]> {
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
}): Promise<Case | null> {
  const { event_id, process_id, instance_id, source_data } = payload;

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
