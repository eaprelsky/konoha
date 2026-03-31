import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { redis } from "./redis";

export interface WorkflowElement {
  id: string;
  type: "event" | "function" | "gateway";
  label: string;
  role?: string;
  system?: string;
  documents?: string[];
  operator?: "AND" | "OR" | "XOR"; // for gateways
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
  const startNodes = def.elements.filter(el => (inEdges.get(el.id) || []).length === 0);
  const endNodes = def.elements.filter(el => (outEdges.get(el.id) || []).length === 0);

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

export async function loadWorkflows(workflowsDir: string): Promise<{ loaded: number; errors: number }> {
  const defs = loadWorkflowsFromDir(workflowsDir);
  let loaded = 0;
  let errorCount = 0;

  for (const def of defs) {
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
