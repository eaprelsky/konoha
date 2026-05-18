import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { redis } from "./redis";
import { pgUpsertWorkflow, pgDeleteWorkflow, pgSaveWorkflowSnapshot, pgGetWorkflow, pgListWorkflows as pgListWorkflowsRaw, pgUpsertRole } from "./storage/pg";
import { syncSchemaToRegistry, cleanupWorkflowRefs } from "./sync/schema-registry-sync";
import { silentCatch, createLogger } from "./logger";
import { upsertDoc, type DocType } from "./runtime/documents";
import type { WorkflowActivationPolicy } from "./event-activation-policy";

const log = createLogger("workflow-loader");

const PG_READ = process.env.PG_READ === "true";

export interface SystemBinding {
  binding_id?: string; // stable payload scope key for action_args, unique within a workflow
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
    kind?: "timer" | "message" | "condition" | "delay_after" | "system" | "manual" | "ambiguous";
    confidence?: number;
    manual_override?: boolean;
    // timer
    cron?: string;
    delay_after?: { ref_event?: string; duration: string };
    duration?: string;
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
    deadline?: string;
    escalation_target?: string;
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
    activation_policy?: WorkflowActivationPolicy;
  };
  // Sub-process: immutable boundary events locked to parent interface
  locked?: boolean;
  // Intent-based execution: outcome/goal for AI agent (vs instruction-based label)
  intent?: string;
  // Sub-process call: explicit reference to child workflow id
  sub_process_id?: string;
}

export interface WorkflowTrigger {
  event_type: string; // e.g. "lead.received"
  start_node: string; // element id to start from
  activation_policy?: WorkflowActivationPolicy;
}

export interface WorkflowDocumentSeed {
  doc_id: string;
  name: string;
  type?: DocType;
  content: string;
}

export type WorkflowLifecycleState = "draft" | "validated" | "deployed" | "executable" | "retired";

export interface WorkflowValidationMetadata {
  status: "passed" | "failed" | "skipped";
  checked_at: string;
  error_count: number;
  errors?: ValidationError[];
  source: string;
}

export interface WorkflowDeployMetadata {
  status: "succeeded" | "blocked" | "retired";
  checked_at: string;
  deployed_at?: string;
  source: string;
  details?: string[];
}

export interface WorkflowUpdateOptions {
  draft?: boolean;
  lifecycleState?: WorkflowLifecycleState;
  deploy?: WorkflowDeployMetadata;
  needsReview?: boolean;
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
  documents?: WorkflowDocumentSeed[];
  elements: WorkflowElement[];
  flow: FlowEdge[]; // [from, to] or [from, to, condition]
  parent_id?: string;        // ID of the parent workflow (if this is a sub-process)
  parent_function_id?: string; // ID of the function node in the parent that this sub-process represents
  status?: string;
  lifecycle_state?: WorkflowLifecycleState;
  last_validation?: WorkflowValidationMetadata;
  last_deploy?: WorkflowDeployMetadata;
  needs_review?: boolean;
}

export interface ValidationError {
  rule: number;
  message: string;
}

const WORKFLOW_KEY_PREFIX = "workflow:";
export const WORKFLOW_INDEX_KEY = "konoha:workflow:index";
const WORKFLOW_LIFECYCLE_STATES = new Set<WorkflowLifecycleState>([
  "draft",
  "validated",
  "deployed",
  "executable",
  "retired",
]);

function nowIso(): string {
  return new Date().toISOString();
}

function validationMetadata(
  errors: ValidationError[],
  source: string,
  status: WorkflowValidationMetadata["status"] = errors.length > 0 ? "failed" : "passed",
): WorkflowValidationMetadata {
  return {
    status,
    checked_at: nowIso(),
    error_count: errors.length,
    ...(errors.length > 0 ? { errors } : {}),
    source,
  };
}

export function getWorkflowLifecycleState(def: Pick<WorkflowDefinition, "status" | "lifecycle_state">): WorkflowLifecycleState {
  if (def.lifecycle_state && WORKFLOW_LIFECYCLE_STATES.has(def.lifecycle_state)) return def.lifecycle_state;
  if (def.status && WORKFLOW_LIFECYCLE_STATES.has(def.status as WorkflowLifecycleState)) {
    return def.status as WorkflowLifecycleState;
  }
  if (def.status === "draft") return "draft";
  if (def.status === "needs_review") return "validated";
  return "executable";
}

export function isWorkflowExecutable(def: WorkflowDefinition): boolean {
  return getWorkflowLifecycleState(def) === "executable";
}

function withLifecycle(
  def: WorkflowDefinition,
  state: WorkflowLifecycleState,
  options: {
    validation?: WorkflowValidationMetadata;
    deploy?: WorkflowDeployMetadata;
    needsReview?: boolean;
    clearDeploy?: boolean;
  } = {},
): WorkflowDefinition {
  const next: WorkflowDefinition = {
    ...def,
    status: state,
    lifecycle_state: state,
    needs_review: options.needsReview,
  };
  if (options.validation) next.last_validation = options.validation;
  if (options.clearDeploy) delete next.last_deploy;
  if (options.deploy) next.last_deploy = options.deploy;
  return next;
}

async function syncWorkflowDocuments(def: WorkflowDefinition): Promise<void> {
  for (const doc of def.documents ?? []) {
    if (!doc.doc_id || !doc.name || typeof doc.content !== "string") {
      throw new Error(`Workflow "${def.id}" has an invalid document seed`);
    }
    await upsertDoc({
      doc_id: doc.doc_id,
      name: doc.name,
      type: doc.type ?? "instruction",
      content: doc.content,
    });
  }
}

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
    for (const w of warnings) log.warn(w);
  }

  const messengerSources = new Set(["telegram", "whatsapp", "email"]);
  for (const trigger of def.triggers ?? []) {
    const start = byId.get(trigger.start_node);
    const startTrigger = start?.type === "event" ? start.trigger : undefined;
    const isMessengerTrigger = (
      (startTrigger?.kind === "message" && startTrigger.source && messengerSources.has(startTrigger.source)) ||
      /^(telegram|whatsapp|email)\./.test(trigger.event_type)
    );
    const activationPolicy = trigger.activation_policy ?? startTrigger?.activation_policy;
    if (isMessengerTrigger && !activationPolicy) {
      errors.push({
        rule: 7,
        message: `Messenger start trigger "${trigger.start_node}" (${trigger.event_type}) must define activation_policy for dedup/rate/backpressure readiness`,
      });
      continue;
    }
    if (activationPolicy) {
      errors.push(...validateActivationPolicy(activationPolicy, trigger.start_node));
    }
  }

  return errors;
}

function validateActivationPolicy(policy: WorkflowActivationPolicy, startNode: string): ValidationError[] {
  const errors: ValidationError[] = [];
  const prefix = `Activation policy for start trigger "${startNode}"`;
  if (policy.min_confidence !== undefined && (typeof policy.min_confidence !== "number" || policy.min_confidence < 0 || policy.min_confidence > 1)) {
    errors.push({ rule: 7, message: `${prefix} has invalid min_confidence; expected number between 0 and 1` });
  }
  if (policy.dedup_window_sec !== undefined && (!Number.isFinite(policy.dedup_window_sec) || policy.dedup_window_sec <= 0)) {
    errors.push({ rule: 7, message: `${prefix} has invalid dedup_window_sec; expected positive seconds` });
  }
  if (policy.rate_limit) {
    if (!Number.isFinite(policy.rate_limit.window_sec) || policy.rate_limit.window_sec <= 0) {
      errors.push({ rule: 7, message: `${prefix} has invalid rate_limit.window_sec; expected positive seconds` });
    }
    if (!Number.isFinite(policy.rate_limit.max_events) || policy.rate_limit.max_events <= 0) {
      errors.push({ rule: 7, message: `${prefix} has invalid rate_limit.max_events; expected positive count` });
    }
  }
  if (policy.backpressure?.max_running_cases !== undefined && (!Number.isFinite(policy.backpressure.max_running_cases) || policy.backpressure.max_running_cases <= 0)) {
    errors.push({ rule: 7, message: `${prefix} has invalid backpressure.max_running_cases; expected positive count` });
  }
  if (policy.sampling && (typeof policy.sampling.rate !== "number" || policy.sampling.rate < 0 || policy.sampling.rate > 1)) {
    errors.push({ rule: 7, message: `${prefix} has invalid sampling.rate; expected number between 0 and 1` });
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
        log.error("Failed to parse workflow file", { path: fullPath, error: e.message });
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
  const normalized = { ...def, elements };
  const lifecycle_state = getWorkflowLifecycleState(normalized);
  return {
    ...normalized,
    status: normalized.status ?? lifecycle_state,
    lifecycle_state,
  };
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
      log.info("Auto-created skeleton role", { role: roleId, workflow: def.id });
    } else {
      // Role key exists — ensure it's in the sorted set (fix orphaned roles, #316)
      const inSortedSet = await redis.zscore("konoha:roles:all", roleId);
      if (inSortedSet === null) {
        await redis.zadd("konoha:roles:all", Date.now(), roleId);
        log.info("Re-added orphaned role to konoha:roles:all", { role: roleId });
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
      log.error("Workflow failed eEPC validation", { workflow: def.id, error_count: validationErrors.length });
      for (const err of validationErrors) {
        log.error("Validation rule violated", { rule: err.rule, message: err.message });
      }
      errorCount++;
      continue;
    }
    await syncWorkflowDocuments(def);
    await redis.set(WORKFLOW_KEY_PREFIX + def.id, JSON.stringify(def));
    await redis.sadd(WORKFLOW_INDEX_KEY, def.id);
    await updateRoleWorkflowIndex(def);
    pgUpsertWorkflow(def as any);
    log.info("Loaded workflow", { id: def.id, version: def.version, redis_key: WORKFLOW_KEY_PREFIX + def.id });
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
const WORKFLOW_CAS_MAX_RETRIES = 16;

function prepareWorkflowUpdate(
  id: string,
  current: WorkflowDefinition,
  patch: Partial<WorkflowDefinition>,
  opts: WorkflowUpdateOptions = {},
): { workflow: WorkflowDefinition; errors: ValidationError[]; persistable: boolean } {
  const updated: WorkflowDefinition = { ...current, ...patch, id }; // id is immutable
  const normalized = normalizeSystems(updated);

  if (opts.draft) {
    return {
      workflow: withLifecycle(normalized, "draft", {
        validation: validationMetadata([], "workflow.update", "skipped"),
        clearDeploy: true,
      }),
      errors: [],
      persistable: true,
    };
  }

  const errors = validateWorkflow(normalized);
  const validation = validationMetadata(errors, opts.lifecycleState === "executable" ? "workflow.deploy" : "workflow.update");
  if (errors.length > 0) {
    return { workflow: withLifecycle(normalized, "draft", { validation, clearDeploy: true }), errors, persistable: false };
  }

  const lifecycleState = opts.lifecycleState ?? "validated";
  return {
    workflow: withLifecycle(normalized, lifecycleState, {
      validation,
      deploy: opts.deploy,
      needsReview: opts.needsReview,
      clearDeploy: lifecycleState !== "executable" && !opts.deploy,
    }),
    errors: [],
    persistable: true,
  };
}

async function archiveWorkflowSnapshot(id: string, current: WorkflowDefinition): Promise<void> {
  const versionNum = await redis.incr(WORKFLOW_VERSION_CTR_PREFIX + id);
  const archived = { ...current, saved_at: new Date().toISOString() };
  await redis.set(`${WORKFLOW_VERSION_KEY_PREFIX}${id}:v${versionNum}`, JSON.stringify(archived));
  await pgSaveWorkflowSnapshot(id, Number(versionNum), archived as any);
}

async function afterWorkflowPersisted(
  saved: WorkflowDefinition,
  current: WorkflowDefinition,
  options: { notifyReload?: boolean } = {},
): Promise<void> {
  await updateRoleWorkflowIndex(saved);
  if (options.notifyReload !== false) {
    redis.xadd("konoha:agent-reload", "*", "type", "workflow.updated", "workflow_id", saved.id, "timestamp", new Date().toISOString()).catch(silentCatch("workflow updated notification"));
  }
  await pgUpsertWorkflow(saved as any);
  syncSchemaToRegistry(saved, current).catch(e => log.error("schema-sync update error", { error: e instanceof Error ? e.message : String(e) }));
}

export type AtomicWorkflowMutation<TMeta, TAbort = unknown> =
  | { patch: Partial<WorkflowDefinition>; opts?: WorkflowUpdateOptions; meta: TMeta }
  | { abort: TAbort };

export type AtomicWorkflowMutationResult<TMeta, TAbort = unknown> =
  | { status: "not_found" }
  | { status: "conflict"; attempts: number }
  | { status: "aborted"; meta: TAbort }
  | { status: "updated"; workflow: WorkflowDefinition; errors: ValidationError[]; meta: TMeta };

export async function mutateWorkflowAtomically<TMeta, TAbort = unknown>(
  id: string,
  mutate: (current: WorkflowDefinition) => AtomicWorkflowMutation<TMeta, TAbort>,
): Promise<AtomicWorkflowMutationResult<TMeta, TAbort>> {
  const key = WORKFLOW_KEY_PREFIX + id;

  for (let attempt = 1; attempt <= WORKFLOW_CAS_MAX_RETRIES; attempt++) {
    const raw = await redis.get(key);
    if (!raw) return { status: "not_found" };

    const current = normalizeSystems(JSON.parse(raw));
    const mutation = mutate(current);
    if ("abort" in mutation) return { status: "aborted", meta: mutation.abort };

    const prepared = prepareWorkflowUpdate(id, current, mutation.patch, mutation.opts);
    if (!prepared.persistable || prepared.errors.length > 0) {
      return { status: "updated", workflow: prepared.workflow, errors: prepared.errors, meta: mutation.meta };
    }

    await syncWorkflowDocuments(prepared.workflow);
    const applied = await redis.eval(
      `
      if redis.call("GET", KEYS[1]) ~= ARGV[1] then
        return 0
      end
      redis.call("SET", KEYS[1], ARGV[2])
      redis.call("SADD", KEYS[2], ARGV[3])
      return 1
      `,
      2,
      key,
      WORKFLOW_INDEX_KEY,
      raw,
      JSON.stringify(prepared.workflow),
      id,
    );

    if (applied === 1) {
      await archiveWorkflowSnapshot(id, JSON.parse(raw));
      await afterWorkflowPersisted(prepared.workflow, current, { notifyReload: mutation.opts?.draft !== true });
      return { status: "updated", workflow: prepared.workflow, errors: [], meta: mutation.meta };
    }
  }

  return { status: "conflict", attempts: WORKFLOW_CAS_MAX_RETRIES };
}

export async function createWorkflow(def: WorkflowDefinition, opts: { draft?: boolean; lifecycleState?: WorkflowLifecycleState } = {}): Promise<{ workflow: WorkflowDefinition; errors: ValidationError[] }> {
  def = normalizeSystems(def);
  if (opts.draft) {
    const saved = withLifecycle(def, "draft", {
      validation: validationMetadata([], "workflow.create", "skipped"),
      clearDeploy: true,
    });
    await syncWorkflowDocuments(saved);
    await redis.set(WORKFLOW_KEY_PREFIX + saved.id, JSON.stringify(saved));
    await redis.sadd(WORKFLOW_INDEX_KEY, saved.id);
    await updateRoleWorkflowIndex(saved);
    await pgUpsertWorkflow(saved as any);
    syncSchemaToRegistry(saved, null).catch(e => log.error("schema-sync create error", { error: e instanceof Error ? e.message : String(e) }));
    return { workflow: saved, errors: [] };
  }
  const errors = validateWorkflow(def);
  const validation = validationMetadata(errors, "workflow.create");
  if (errors.length > 0) return { workflow: withLifecycle(def, "draft", { validation, clearDeploy: true }), errors };
  const lifecycleState = opts.lifecycleState ?? "validated";
  const saved = withLifecycle(def, lifecycleState, { validation, clearDeploy: lifecycleState !== "executable" });
  await syncWorkflowDocuments(saved);
  await redis.set(WORKFLOW_KEY_PREFIX + saved.id, JSON.stringify(saved));
  await redis.sadd(WORKFLOW_INDEX_KEY, def.id);
  await updateRoleWorkflowIndex(saved);
  await pgUpsertWorkflow(saved as any);
  syncSchemaToRegistry(saved, null).catch(e => log.error("schema-sync create error", { error: e instanceof Error ? e.message : String(e) }));
  return { workflow: saved, errors: [] };
}

export async function updateWorkflow(id: string, patch: Partial<WorkflowDefinition>, opts: WorkflowUpdateOptions = {}): Promise<{ workflow: WorkflowDefinition; errors: ValidationError[] } | null> {
  const raw = await redis.get(WORKFLOW_KEY_PREFIX + id);
  if (!raw) return null;

  const current: WorkflowDefinition = JSON.parse(raw);

  // Archive current version before overwriting
  await archiveWorkflowSnapshot(id, JSON.parse(raw));

  const prepared = prepareWorkflowUpdate(id, current, patch, opts);
  if (!prepared.persistable || prepared.errors.length > 0) return { workflow: prepared.workflow, errors: prepared.errors };

  await syncWorkflowDocuments(prepared.workflow);
  await redis.set(WORKFLOW_KEY_PREFIX + id, JSON.stringify(prepared.workflow));
  await afterWorkflowPersisted(prepared.workflow, current, { notifyReload: opts.draft !== true });
  return { workflow: prepared.workflow, errors: [] };
}

export async function archiveWorkflow(id: string): Promise<boolean> {
  const raw = await redis.get(WORKFLOW_KEY_PREFIX + id);
  if (!raw) return false;
  const def: WorkflowDefinition = JSON.parse(raw);
  await redis.srem(WORKFLOW_INDEX_KEY, id);
  await removeFromRoleWorkflowIndex(def);
  // Emit orphan warnings for roles/docs that were exclusive to this workflow
  cleanupWorkflowRefs(def).catch(e => log.error("schema-sync archiveWorkflow cleanup error", { error: e instanceof Error ? e.message : String(e) }));
  await pgDeleteWorkflow(id);
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
