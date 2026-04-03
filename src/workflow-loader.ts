import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { redis } from "./redis";

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
  // Trigger config (start event nodes only)
  trigger?: {
    type: "manual" | "telegram" | "schedule" | "event" | "webhook";
    chat_id?: string;        // for telegram: Telegram chat_id to listen
    keyword?: string;        // for telegram: keyword filter
    cron?: string;           // for schedule: cron expression
    event_type?: string;     // for event: upstream event type to react to
    webhook_path?: string;   // for webhook: auto-generated URL suffix
  };
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

  // Rule 1: Process must start with an event and end with an event
  // Only consider flow-topology elements (events, functions, gateways).
  // Roles, documents, and systems are organizational metadata — they have no flow edges
  // and must not be counted as start/end nodes regardless of their position in elements[].
  const FLOW_TYPES = new Set(["event", "function", "gateway"]);
  const flowEls = def.elements.filter(el => FLOW_TYPES.has(el.type));
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
  for (const [from, to] of def.flow) {
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
  for (const el of def.elements) {
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
  for (const el of def.elements) {
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
  for (const el of def.elements) {
    if (el.type !== "gateway") continue;
    const ins = (inEdges.get(el.id) || []).map(id => byId.get(id));
    const outs = (outEdges.get(el.id) || []).map(id => byId.get(id));
    if (!hasFunctionWithin1Hop(ins, "in") && !hasFunctionWithin1Hop(outs, "out")) {
      errors.push({ rule: 4, message: `Gateway "${el.id}" is not connected to a function on either side` });
    }
  }

  // Rule 5: Each function must have exactly one role (assignee)
  for (const el of def.elements) {
    if (el.type !== "function") continue;
    if (!el.role) {
      errors.push({ rule: 5, message: `Function "${el.id}" ("${el.label}") has no role assigned` });
    }
    // Multiple roles would require decomposition — we enforce single role via the schema (role is a string, not array)
  }

  // Rule 6: Event/function label style — warn if event label looks like an infinitive or function looks like past fact
  // (not enforced hard, logged as warning per spec)
  for (const el of def.elements) {
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

// Normalize legacy `system` string → `systems` array (backward compat for issue #156)
function normalizeSystems(def: WorkflowDefinition): WorkflowDefinition {
  const elements = def.elements.map(el => {
    if (el.type !== "function") return el;
    if (el.system && !el.systems) {
      return { ...el, systems: [{ connector: el.system, operation: "default" }] };
    }
    return el;
  });
  return { ...def, elements };
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
    console.log(`[workflow-loader] Loaded workflow "${def.id}" v${def.version} → Redis key ${WORKFLOW_KEY_PREFIX}${def.id}`);
    loaded++;
  }

  return { loaded, errors: errorCount };
}

export async function getWorkflow(id: string): Promise<WorkflowDefinition | null> {
  const raw = await redis.get(WORKFLOW_KEY_PREFIX + id);
  if (!raw) return null;
  return JSON.parse(raw);
}

export async function listWorkflows(): Promise<WorkflowDefinition[]> {
  const ids = await redis.smembers(WORKFLOW_INDEX_KEY);
  if (ids.length === 0) return [];
  const keys = ids.map(id => WORKFLOW_KEY_PREFIX + id);
  const values = await redis.mget(...keys);
  const results: WorkflowDefinition[] = [];
  for (const v of values) {
    if (v) {
      try { results.push(JSON.parse(v)); } catch { /* skip corrupt entries */ }
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
    return { workflow: saved, errors: [] };
  }
  const errors = validateWorkflow(def);
  if (errors.length > 0) return { workflow: def, errors };
  await redis.set(WORKFLOW_KEY_PREFIX + def.id, JSON.stringify(def));
  await redis.sadd(WORKFLOW_INDEX_KEY, def.id);
  return { workflow: def, errors: [] };
}

export async function updateWorkflow(id: string, patch: Partial<WorkflowDefinition>, opts: { draft?: boolean } = {}): Promise<{ workflow: WorkflowDefinition; errors: ValidationError[] } | null> {
  const raw = await redis.get(WORKFLOW_KEY_PREFIX + id);
  if (!raw) return null;

  const current: WorkflowDefinition = JSON.parse(raw);

  // Archive current version before overwriting
  const versionNum = await redis.incr(WORKFLOW_VERSION_CTR_PREFIX + id);
  await redis.set(`${WORKFLOW_VERSION_KEY_PREFIX}${id}:v${versionNum}`, raw);

  const updated: WorkflowDefinition = { ...current, ...patch, id }; // id is immutable
  const normalized = normalizeSystems(updated);

  if (opts.draft) {
    const saved = { ...normalized, status: 'draft' };
    await redis.set(WORKFLOW_KEY_PREFIX + id, JSON.stringify(saved));
    return { workflow: saved, errors: [] };
  }

  const errors = validateWorkflow(normalized);
  if (errors.length > 0) return { workflow: normalized, errors };

  await redis.set(WORKFLOW_KEY_PREFIX + id, JSON.stringify(normalized));
  return { workflow: normalized, errors: [] };
}

export async function archiveWorkflow(id: string): Promise<boolean> {
  const exists = await redis.exists(WORKFLOW_KEY_PREFIX + id);
  if (!exists) return false;
  await redis.srem(WORKFLOW_INDEX_KEY, id);
  // Keep the key in Redis (archived, not deleted) — remove from active index only
  return true;
}

export async function listWorkflowVersions(id: string): Promise<WorkflowDefinition[]> {
  const pattern = `${WORKFLOW_VERSION_KEY_PREFIX}${id}:v*`;
  const keys = await redis.keys(pattern);
  if (keys.length === 0) return [];
  const values = await redis.mget(...keys);
  const results: WorkflowDefinition[] = [];
  for (const v of values) {
    if (v) {
      try { results.push(JSON.parse(v)); } catch { /* skip */ }
    }
  }
  return results.sort((a, b) => a.version.localeCompare(b.version));
}
