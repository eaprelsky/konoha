import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { redis } from "./redis";
import { pgUpsertWorkflow, pgDeleteWorkflow, pgSaveWorkflowSnapshot, pgGetWorkflow, pgListWorkflows as pgListWorkflowsRaw, pgUpsertRole } from "./storage/pg";

const PG_READ = process.env.PG_READ === "true";

export interface SystemBinding {
  connector: string;  // adapter name (e.g. "telegram", "bitrix24")
  operation?: string; // specific operation; defaults to function label slug
}

export interface WorkflowElement {
  id: string;
  type: "event" | "function" | "gateway";
  label: string;
  role?: string;
  system?: string;           // legacy single system (auto-converted to systems on load)
  systems?: SystemBinding[]; // multi-system bindings (section 13 of spec)
  documents?: string[];
  operator?: "AND" | "OR" | "XOR"; // for gateways
  // Document node inline content (used when type="document" in frontend schema)
  content_type?: "instruction" | "file";
  content?: string;          // inline text for instruction-type documents
  file_ref?: string;         // workspace file name for file-type documents
  // Trigger config (start/intermediate event nodes)
  // Uses `kind` (new). Legacy `type` field is migrated to `kind` on read.
  trigger?: {
    kind?: "timer" | "message" | "condition" | "system" | "manual" | "ambiguous";
    confidence?: number;
    manual_override?: boolean;
    // timer
    cron?: string;
    delay_after?: { ref_event?: string; duration: string };
    // message
    source?: string;
    filter?: Record<string, unknown>;
    // condition
    data_source?: string;
    query?: { entity: string; filter: Record<string, unknown>; metric: string; sum_field?: string };
    operator?: ">" | "<" | ">=" | "<=" | "==" | "!=";
    threshold?: number;
    poll_interval?: string;
    // manual
    action?: string;
    role?: string;
    // system
    event_name?: string;
    process_ref?: string;
    function_ref?: string;
    // Legacy fields (auto-migrated to `kind` on read, never used in new code)
    /** @deprecated use kind instead */
    type?: "manual" | "telegram" | "schedule" | "event" | "webhook";
    chat_id?: string;
    keyword?: string;
    event_type?: string;
    webhook_path?: string;
  };
  // Sub-process: immutable boundary events locked to parent interface
  locked?: boolean;
  // Intent-based execution: outcome/goal for AI agent (vs instruction-based label)
  intent?: string;
}

export interface WorkflowTrigger {
  event_type: string; // e.g. "lead.received"
  start_node: string; // element id to start from
}

// Flow edge: [from, to] or [from, to, condition]
// condition is a JS expression evaluated against case payload (e.g. "payload.qualified === true")
export type FlowEdge = [string, string] | [string, string, string];

export interface WorkflowDefinition {
  id: string;
  version: string;
  name: string;
  description?: string;
  triggers?: WorkflowTrigger[];
  elements: WorkflowElement[];
  flow: FlowEdge[]; // [from, to] or [from, to, condition]
  parent_id?: string;        // ID of the parent workflow (if this is a sub-process)
  parent_function_id?: string; // ID of the function node in the parent that this sub-process represents
}

export interface ValidationError {
  rule: number;
  message: string;
}

const WORKFLOW_KEY_PREFIX = "workflow:";
export const WORKFLOW_INDEX_KEY = "konoha:workflow:index";

// --- eEPC Validation (6 rules from spec 2.1) ---

export function validateWorkflow(def: WorkflowDefinition): ValidationError[] {
  const errors: ValidationError[] = [];
  const warnings: string[] = [];
  const elements = def.elements ?? [];
  const flow = def.flow ?? [];

  const byId = new Map<string, WorkflowElement>(elements.map(e => [e.id, e]));
  const outEdges = new Map<string, string[]>();
  const inEdges = new Map<string, string[]>();

  for (const el of elements) {
    outEdges.set(el.id, []);
    inEdges.set(el.id, []);
  }
  for (const [from, to] of flow) {
    outEdges.get(from)?.push(to);
    inEdges.get(to)?.push(from);
  }

  // Rule 1: Process must start with an event and end with an event
  // Only consider flow-topology elements (events, functions, gateways).
  // Roles, documents, and systems are organizational metadata — they have no flow edges
  // and must not be counted as start/end nodes regardless of their position in elements[].
  const FLOW_TYPES = new Set(["event", "function", "gateway"]);
  const flowEls = elements.filter(el => FLOW_TYPES.has(el.type));
  const startNodes = flowEls.filter(el => (inEdges.get(el.id) || []).length === 0);
  const endNodes   = flowEls.filter(el => (outEdges.get(el.id) || []).length === 0);

  if (!startNodes.every(n => n.type === "event")) {
    errors.push({ rule: 1, message: `Process must start with an event. Non-event start nodes: ${startNodes.filter(n => n.type !== "event").map(n => n.id).join(", ")}` });
  }
  if (!endNodes.every(n => n.type === "event")) {
    errors.push({ rule: 1, message: `Process must end with an event. Non-event end nodes: ${endNodes.filter(n => n.type !== "event").map(n => n.id).join(", ")}` });
  }

  // Rule 2: Events and functions must alternate — no two events in a row (even through gateways)
  // Direct edge check: event → event is forbidden; function → function is forbidden
  for (const [from, to] of flow) {
    const fromEl = byId.get(from);
    const toEl = byId.get(to);
    if (!fromEl || !toEl) continue;
    if (fromEl.type === "event" && toEl.type === "event") {
      errors.push({ rule: 2, message: `Event "${from}" directly connected to event "${to}" — events must be separated by a function or gateway` });
    }
    if (fromEl.type === "function" && toEl.type === "function") {
      errors.push({ rule: 2, message: `Function "${from}" directly connected to function "${to}" — functions must be separated by an event or gateway` });
    }
  }

  // Rule 2 (continued): gateway must not have both function inputs and function outputs
  // This catches function→gateway→function which violates the alternation principle
  for (const el of elements) {
    if (el.type !== "gateway") continue;
    const ins = (inEdges.get(el.id) || []).map(id => byId.get(id));
    const outs = (outEdges.get(el.id) || []).map(id => byId.get(id));
    const hasFunctionIn = ins.some(e => e?.type === "function");
    const hasFunctionOut = outs.some(e => e?.type === "function");
    if (hasFunctionIn && hasFunctionOut) {
      errors.push({ rule: 2, message: `Gateway "${el.id}" has function inputs and function outputs — function→gateway→function violates alternation (add an intermediate event)` });
    }
  }

  // Rule 3: Roles, documents, systems must be attached only to functions (not events or gateways)
  for (const el of elements) {
    if (el.type !== "function") {
      if (el.role) errors.push({ rule: 3, message: `Element "${el.id}" (${el.type}) has a role — roles must only be attached to functions` });
      if (el.system) errors.push({ rule: 3, message: `Element "${el.id}" (${el.type}) has a system — systems must only be attached to functions` });
      if (el.documents?.length) errors.push({ rule: 3, message: `Element "${el.id}" (${el.type}) has documents — documents must only be attached to functions` });
    }
  }

  // Rule 4: Gateway nodes must be connected to a function on at least one side
  // "Connected" means directly or within one hop through an intermediate event
  // (eEPC standard allows: function → event → gateway → event → function chains)
  function hasFunctionWithin1Hop(neighbors: (WorkflowElement | undefined)[], direction: "in" | "out"): boolean {
    for (const el of neighbors) {
      if (!el) continue;
      if (el.type === "function") return true;
      if (el.type === "event") {
        // Look one hop further in the given direction
        const nextIds = direction === "out" ? outEdges.get(el.id) || [] : inEdges.get(el.id) || [];
        if (nextIds.some(id => byId.get(id)?.type === "function")) return true;
      }
    }
    return false;
  }
  for (const el of elements) {
    if (el.type !== "gateway") continue;
    const ins = (inEdges.get(el.id) || []).map(id => byId.get(id));
    const outs = (outEdges.get(el.id) || []).map(id => byId.get(id));
    if (!hasFunctionWithin1Hop(ins, "in") && !hasFunctionWithin1Hop(outs, "out")) {
      errors.push({ rule: 4, message: `Gateway "${el.id}" is not connected to a function on either side` });
    }
  }

  // Rule 5: Each function must have exactly one role (assignee)
  for (const el of elements) {
    if (el.type !== "function") continue;
    if (!el.role) {
      errors.push({ rule: 5, message: `Function "${el.id}" ("${el.label}") has no role assigned` });
    }
    // Multiple roles would require decomposition — we enforce single role via the schema (role is a string, not array)
  }

  // Rule 6: Event/function label style — warn if event label looks like an infinitive or function looks like past fact
  // (not enforced hard, logged as warning per spec)
  for (const el of elements) {
    if (el.type === "event" && /^(выполнить|создать|получить|отправить|проверить)/i.test(el.label)) {
      warnings.push(`Rule 6 warning: event "${el.id}" label "${el.label}" looks like an infinitive — events should describe a completed fact`);
    }
  }

  if (warnings.length > 0) {
    for (const w of warnings) console.warn(`[workflow-loader] ${w}`);
  }

  return errors;
}

// --- Loader ---

function loadWorkflowsFromDir(dir: string): WorkflowDefinition[] {
  const results: WorkflowDefinition[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      results.push(...loadWorkflowsFromDir(fullPath));
    } else if (entry.endsWith(".json")) {
      try {
        const raw = readFileSync(fullPath, "utf-8");
        const def: WorkflowDefinition = JSON.parse(raw);
        results.push(def);
      } catch (e: any) {
        console.error(`[workflow-loader] Failed to parse ${fullPath}: ${e.message}`);
      }
    }
  }
  return results;
}

// ── trigger.type → trigger.kind migration (issue #229) ───────────────────────
// Applied at READ time so all downstream code works only with `kind`.

type LegacyTrigger = NonNullable<WorkflowElement["trigger"]> & { type?: string };

function migrateTriggerKind(trigger: LegacyTrigger): NonNullable<WorkflowElement["trigger"]> {
  if (!trigger.type || trigger.kind) return trigger; // already migrated or no legacy field

  const { type, chat_id, keyword, event_type, webhook_path, ...rest } = trigger as any;

  switch (type) {
    case "schedule":
      return { ...rest, kind: "timer" };
    case "event":
      return { ...rest, kind: "system", event_name: event_type ?? "process_completed", confidence: 0.9 };
    case "telegram":
      return {
        ...rest, kind: "message", source: "telegram",
        filter: { message_type: "text", ...(chat_id ? { chat_id } : {}), ...(keyword ? { keyword } : {}) },
        confidence: 0.9,
      };
    case "webhook":
      return {
        ...rest, kind: "message", source: "webhook",
        filter: { ...(webhook_path ? { path: webhook_path } : {}) },
        confidence: 0.9,
      };
    case "manual":
      return { ...rest, kind: "manual", action: "complete", role: "user", confidence: 1.0 };
    default:
      return trigger;
  }
}

// Normalize legacy `system` string → `systems` array (backward compat for issue #156)
// Also applies trigger.type → trigger.kind migration at read time.
function normalizeWorkflow(def: WorkflowDefinition): WorkflowDefinition {
  const elements = (def.elements ?? []).map(el => {
    let out = { ...el };
    // systems normalization
    if (out.type === "function" && out.system && !out.systems) {
      out = { ...out, systems: [{ connector: out.system, operation: "default" }] };
    }
    // trigger migration
    if (out.trigger) {
      out = { ...out, trigger: migrateTriggerKind(out.trigger as LegacyTrigger) };
    }
    return out;
  });
  return { ...def, elements };
}

/** @deprecated use normalizeWorkflow instead */
const normalizeSystems = normalizeWorkflow;

// ── Role-workflow index ─────────────────────────────────────────────────────
// `konoha:role:{roleId}:workflows` (Set) — populated whenever a workflow is saved.
// Used by buildRoleBlocks() in agent-lifecycle to build composite agent prompts.

export async function updateRoleWorkflowIndex(def: WorkflowDefinition): Promise<void> {
  const roleIds = new Set<string>();
  for (const el of def.elements ?? []) {
    if (el.type === "function" && el.role) roleIds.add(el.role);
  }
  for (const roleId of roleIds) {
    await redis.sadd(`konoha:role:${roleId}:workflows`, def.id);

    // Ensure role is visible in konoha:roles:all (read by buildRoleBlocks).
    // Two cases:
    //   1. role:{roleId} missing → create skeleton (role referenced before POST /roles)
    //   2. role:{roleId} exists but NOT in sorted set → add it (orphaned: desync)
    const exists = await redis.exists(`role:${roleId}`);
    if (!exists) {
      const now = new Date().toISOString();
      const skeleton = {
        role_id: roleId,
        name: roleId,
        description: "",
        assignees: [],
        strategy: "manual" as const,
        required_capabilities: [],
        created_at: now,
        updated_at: now,
      };
      await redis.set(`role:${roleId}`, JSON.stringify(skeleton));
      await redis.zadd("konoha:roles:all", Date.now(), roleId);
      pgUpsertRole({ id: roleId, name: roleId, description: '', assignees: [], strategy: 'manual', updated_at: skeleton.updated_at });
      console.log(`[workflow-loader] Auto-created skeleton role "${roleId}" (workflow "${def.id}")`);
    } else {
      // Role key exists — ensure it's in the sorted set (fix orphaned roles, #316)
      const inSortedSet = await redis.zscore("konoha:roles:all", roleId);
      if (inSortedSet === null) {
        await redis.zadd("konoha:roles:all", Date.now(), roleId);
        console.log(`[workflow-loader] Re-added orphaned role "${roleId}" to konoha:roles:all`);
      }
    }
  }
}

export async function removeFromRoleWorkflowIndex(def: WorkflowDefinition): Promise<void> {
  const roleIds = new Set<string>();
  for (const el of def.elements ?? []) {
    if (el.type === "function" && el.role) roleIds.add(el.role);
  }
  for (const roleId of roleIds) {
    await redis.srem(`konoha:role:${roleId}:workflows`, def.id);
  }
}

export async function loadWorkflows(workflowsDir: string): Promise<{ loaded: number; errors: number }> {
  const defs = loadWorkflowsFromDir(workflowsDir);
  let loaded = 0;
  let errorCount = 0;

  for (let def of defs) {
    def = normalizeSystems(def);
    const validationErrors = validateWorkflow(def);
    if (validationErrors.length > 0) {
      console.error(`[workflow-loader] Workflow "${def.id}" failed eEPC validation (${validationErrors.length} error(s)):`);
      for (const err of validationErrors) {
        console.error(`  [Rule ${err.rule}] ${err.message}`);
      }
      errorCount++;
      continue;
    }
    await redis.set(WORKFLOW_KEY_PREFIX + def.id, JSON.stringify(def));
    await redis.sadd(WORKFLOW_INDEX_KEY, def.id);
    await updateRoleWorkflowIndex(def);
    pgUpsertWorkflow(def as any);
    console.log(`[workflow-loader] Loaded workflow "${def.id}" v${def.version} → Redis key ${WORKFLOW_KEY_PREFIX}${def.id}`);
    loaded++;
  }

  return { loaded, errors: errorCount };
}

export async function getWorkflow(id: string): Promise<WorkflowDefinition | null> {
  if (PG_READ) {
    const row = await pgGetWorkflow(id);
    if (!row) return null;
    return normalizeWorkflow(row as unknown as WorkflowDefinition);
  }
  const raw = await redis.get(WORKFLOW_KEY_PREFIX + id);
  if (!raw) return null;
  return normalizeWorkflow(JSON.parse(raw));
}

export async function listWorkflows(): Promise<WorkflowDefinition[]> {
  if (PG_READ) {
    const rows = await pgListWorkflowsRaw();
    return rows.map(r => normalizeWorkflow(r as unknown as WorkflowDefinition));
  }
  const ids = await redis.smembers(WORKFLOW_INDEX_KEY);
  if (ids.length === 0) return [];
  const keys = ids.map(id => WORKFLOW_KEY_PREFIX + id);
  const values = await redis.mget(...keys);
  const results: WorkflowDefinition[] = [];
  for (const v of values) {
    if (v) {
      try { results.push(normalizeWorkflow(JSON.parse(v))); } catch { /* skip corrupt entries */ }
    }
  }
  return results;
}

// --- CRUD (issue #152) ---

const WORKFLOW_VERSION_KEY_PREFIX = "workflow:version:"; // workflow:{id}:v{N}
const WORKFLOW_VERSION_CTR_PREFIX = "konoha:workflow:versionctr:"; // INCR counter per workflow id

export async function createWorkflow(def: WorkflowDefinition, opts: { draft?: boolean } = {}): Promise<{ workflow: WorkflowDefinition; errors: ValidationError[] }> {
  def = normalizeSystems(def);
  if (opts.draft) {
    const saved = { ...def, status: 'draft' };
    await redis.set(WORKFLOW_KEY_PREFIX + saved.id, JSON.stringify(saved));
    await redis.sadd(WORKFLOW_INDEX_KEY, saved.id);
    await updateRoleWorkflowIndex(saved as WorkflowDefinition);
    pgUpsertWorkflow(saved as any);
    return { workflow: saved, errors: [] };
  }
  const errors = validateWorkflow(def);
  if (errors.length > 0) return { workflow: def, errors };
  await redis.set(WORKFLOW_KEY_PREFIX + def.id, JSON.stringify(def));
  await redis.sadd(WORKFLOW_INDEX_KEY, def.id);
  await updateRoleWorkflowIndex(def);
  pgUpsertWorkflow(def as any);
  return { workflow: def, errors: [] };
}

export async function updateWorkflow(id: string, patch: Partial<WorkflowDefinition>, opts: { draft?: boolean } = {}): Promise<{ workflow: WorkflowDefinition; errors: ValidationError[] } | null> {
  const raw = await redis.get(WORKFLOW_KEY_PREFIX + id);
  if (!raw) return null;

  const current: WorkflowDefinition = JSON.parse(raw);

  // Archive current version before overwriting
  const versionNum = await redis.incr(WORKFLOW_VERSION_CTR_PREFIX + id);
  const archived = { ...JSON.parse(raw), saved_at: new Date().toISOString() };
  await redis.set(`${WORKFLOW_VERSION_KEY_PREFIX}${id}:v${versionNum}`, JSON.stringify(archived));
  pgSaveWorkflowSnapshot(id, Number(versionNum), archived as any);

  const updated: WorkflowDefinition = { ...current, ...patch, id }; // id is immutable
  const normalized = normalizeSystems(updated);

  if (opts.draft) {
    const saved = { ...normalized, status: 'draft' };
    await redis.set(WORKFLOW_KEY_PREFIX + id, JSON.stringify(saved));
    await updateRoleWorkflowIndex(saved as WorkflowDefinition);
    pgUpsertWorkflow(saved as any);
    return { workflow: saved, errors: [] };
  }

  const errors = validateWorkflow(normalized);
  if (errors.length > 0) return { workflow: normalized, errors };

  await redis.set(WORKFLOW_KEY_PREFIX + id, JSON.stringify(normalized));
  await updateRoleWorkflowIndex(normalized);
  // Notify hot-reload listener: agents with roles in this workflow need CLAUDE.md refresh
  redis.xadd("konoha:agent-reload", "*", "type", "workflow.updated", "workflow_id", id, "timestamp", new Date().toISOString()).catch(() => {});
  pgUpsertWorkflow(normalized as any);
  return { workflow: normalized, errors: [] };
}

export async function archiveWorkflow(id: string): Promise<boolean> {
  const raw = await redis.get(WORKFLOW_KEY_PREFIX + id);
  if (!raw) return false;
  const def: WorkflowDefinition = JSON.parse(raw);
  await redis.srem(WORKFLOW_INDEX_KEY, id);
  await removeFromRoleWorkflowIndex(def);
  pgDeleteWorkflow(id);
  // Keep the key in Redis (archived, not deleted) — remove from active index only
  return true;
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

export async function listWorkflowVersions(id: string): Promise<{ version: string; saved_at?: string }[]> {
  const pattern = `${WORKFLOW_VERSION_KEY_PREFIX}${id}:v*`;
  const keys = await scanKeys(pattern);
  if (keys.length === 0) return [];
  const values = await redis.mget(...keys);
  const prefix = `${WORKFLOW_VERSION_KEY_PREFIX}${id}:v`;
  const results: { version: string; saved_at?: string }[] = [];
  for (let i = 0; i < keys.length; i++) {
    const v = values[i];
    if (v) {
      try {
        const parsed = JSON.parse(v);
        const snapshotNum = keys[i].slice(prefix.length);
        results.push({ version: snapshotNum, saved_at: parsed.saved_at });
      } catch { /* skip */ }
    }
  }
  return results.sort((a, b) => Number(a.version) - Number(b.version));
}

export async function getWorkflowVersion(id: string, snapshotNum: string): Promise<WorkflowDefinition | null> {
  const raw = await redis.get(`${WORKFLOW_VERSION_KEY_PREFIX}${id}:v${snapshotNum}`);
  if (!raw) return null;
  return normalizeWorkflow(JSON.parse(raw));
}
