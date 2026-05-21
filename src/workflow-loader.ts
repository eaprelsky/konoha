import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { redis } from "./redis";
import { pgUpsertWorkflow, pgSaveWorkflowSnapshot, pgGetWorkflowSnapshot, pgGetWorkflow, pgListWorkflows as pgListWorkflowsRaw, pgUpsertRole } from "./storage/pg";
import { syncSchemaToRegistry, cleanupWorkflowRefs } from "./sync/schema-registry-sync";
import { silentCatch, createLogger } from "./logger";
import { upsertDoc, type DocType } from "./runtime/documents";
import type { WorkflowActivationPolicy } from "./event-activation-policy";
import { analyzeGatewayCondition } from "./workflow-gateway-conditions";
import * as nodeCron from "node-cron";
import { parseBdDuration } from "./work-calendar";
import { parseDurationMs } from "./events/utils";

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
  x?: number;
  y?: number;
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
    // ambiguous resolver output
    candidates?: unknown[];
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
  // Optional payload fields materialized by this function for gateway-readiness checks.
  output_fields?: string[];
  output_schema?: { fields?: string[]; properties?: Record<string, unknown>; required?: string[] };
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
export type WorkflowValidationStatus = "unknown" | "skipped" | "passed" | "failed";

export interface WorkflowLifecycleMetadata {
  schema_version: 1;
  state: WorkflowLifecycleState;
  status: WorkflowLifecycleState;
  validation_status: WorkflowValidationStatus;
  deploy_version: number;
  validated_at?: string;
  deployed_at?: string;
  deployed_by?: string;
  retired_at?: string;
  retired_by?: string;
  migrated_from_status?: string;
  backfilled_at?: string;
}

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
  deploy_version?: number;
  deployed_at?: string;
  deployed_by?: string;
  source: string;
  details?: string[];
}

export interface WorkflowUpdateOptions {
  draft?: boolean;
  lifecycleState?: WorkflowLifecycleState;
  deploy?: WorkflowDeployMetadata;
  needsReview?: boolean;
  source?: string;
}

export interface WorkflowArchiveOptions {
  source?: string;
  retiredBy?: string;
}

export interface WorkflowRuntimeSnapshotBinding {
  workflow_id: string;
  deploy_version: number;
  snapshot_key: string;
  bound_at: string;
  source: string;
}

// Flow edge: [from, to] or [from, to, condition]
// condition uses the gateway condition DSL evaluated against case payload
// (e.g. "payload.qualified === true").
export type FlowEdge = [string, string] | [string, string, string];

export interface WorkflowDefinition {
  id: string;
  version: string;
  name: string;
  description?: string;
  triggers?: WorkflowTrigger[];
  documents?: WorkflowDocumentSeed[];
  payload_fields?: string[];
  payload_schema?: { fields?: string[]; properties?: Record<string, unknown>; required?: string[] };
  elements: WorkflowElement[];
  flow: FlowEdge[]; // [from, to] or [from, to, condition]
  parent_id?: string;        // ID of the parent workflow (if this is a sub-process)
  parent_function_id?: string; // ID of the function node in the parent that this sub-process represents
  status?: string;
  lifecycle_state?: WorkflowLifecycleState;
  lifecycle?: WorkflowLifecycleMetadata;
  validation_status?: WorkflowValidationStatus;
  deploy_version?: number;
  deployed_at?: string;
  deployed_by?: string;
  retired_at?: string;
  retired_by?: string;
  last_validation?: WorkflowValidationMetadata;
  last_deploy?: WorkflowDeployMetadata;
  needs_review?: boolean;
}

export interface ValidationError {
  rule: number;
  message: string;
  code: string;
  class: WorkflowValidationClass;
  element_id?: string;
  edge?: FlowEdge;
  details?: Record<string, unknown>;
  legacy_code?: string;
}

export const WORKFLOW_VALIDATION_TAXONOMY_VERSION = 1;
export type WorkflowValidationClass = "graph" | "role" | "trigger" | "adapter" | "document" | "deployment" | "migration" | "lifecycle";
export type WorkflowValidationSeverity = "error" | "warning";
export type WorkflowReadiness = "ready" | "warning" | "blocked";

export interface WorkflowValidationIssue {
  code: string;
  severity: WorkflowValidationSeverity;
  class: WorkflowValidationClass;
  message: string;
  element_id?: string;
  edge?: FlowEdge;
  details?: Record<string, unknown>;
  legacy_code?: string;
}

export interface WorkflowValidationContext {
  roles?: { role_id: string; assignees?: string[]; strategy?: string }[];
  documents?: { doc_id: string }[];
  adapters?: string[];
  running_case_count?: number;
  source?: string;
}

export interface WorkflowValidationReceipt {
  workflow_id: string;
  taxonomy_version: number;
  readiness: WorkflowReadiness;
  source: string;
  errors: WorkflowValidationIssue[];
  warnings: WorkflowValidationIssue[];
  checked_at: string;
  gates: {
    deployment_blocker: boolean;
    case_start_blocker: boolean;
    release_blocker: boolean;
    reviewer_required: boolean;
  };
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
const TRIGGER_ACTIONS = new Set(["approve", "reject", "submit", "complete", "escalate"]);
const TRIGGER_SYSTEM_EVENTS = new Set([
  "process_completed",
  "process_error",
  "subprocess_completed",
  "function_completed",
  "all_branches_completed",
]);
const TRIGGER_CONDITION_OPERATORS = new Set([">", "<", ">=", "<=", "==", "!="]);

function nowIso(): string {
  return new Date().toISOString();
}

function isoValue(value: unknown): string | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString();
  return String(value);
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

function isWorkflowLifecycleState(value: unknown): value is WorkflowLifecycleState {
  return typeof value === "string" && WORKFLOW_LIFECYCLE_STATES.has(value as WorkflowLifecycleState);
}

function legacyStatusToLifecycle(status: unknown): WorkflowLifecycleState | null {
  if (!status || typeof status !== "string") return null;
  if (isWorkflowLifecycleState(status)) return status;
  if (status === "active") return "executable";
  if (status === "needs_review") return "validated";
  if (status === "archived" || status === "deleted") return "retired";
  return null;
}

export function getWorkflowLifecycleState(def: Pick<WorkflowDefinition, "status" | "lifecycle_state">): WorkflowLifecycleState {
  if (isWorkflowLifecycleState(def.lifecycle_state)) return def.lifecycle_state;
  const state = legacyStatusToLifecycle(def.status);
  if (state) return state;
  return "executable";
}

export function getWorkflowDeployVersion(def: Pick<WorkflowDefinition, "deploy_version" | "lifecycle" | "last_deploy" | "lifecycle_state" | "status">): number {
  const explicit = Number(def.last_deploy?.deploy_version ?? def.deploy_version ?? def.lifecycle?.deploy_version);
  if (Number.isFinite(explicit) && explicit >= 0) return Math.trunc(explicit);
  const state = getWorkflowLifecycleState(def);
  return state === "executable" && def.last_deploy?.status === "succeeded" ? 1 : 0;
}

export function buildWorkflowLifecycleMetadata(
  def: WorkflowDefinition,
  state: WorkflowLifecycleState = getWorkflowLifecycleState(def),
): WorkflowLifecycleMetadata {
  const previous = def.lifecycle;
  const validationStatus = (def.last_validation?.status ?? def.validation_status ?? previous?.validation_status ?? "unknown") as WorkflowValidationStatus;
  const deployedAt = isoValue(def.last_deploy?.deployed_at ?? def.deployed_at ?? previous?.deployed_at);
  const retiredAt = isoValue(def.retired_at ?? previous?.retired_at);
  const migratedFromStatus =
    previous?.migrated_from_status ??
    (def.status && !isWorkflowLifecycleState(def.status) ? String(def.status) : undefined);
  return {
    schema_version: 1,
    state,
    status: state,
    validation_status: validationStatus,
    deploy_version: getWorkflowDeployVersion(def),
    ...(def.last_validation?.checked_at ? { validated_at: def.last_validation.checked_at } : {}),
    ...(deployedAt ? { deployed_at: deployedAt } : {}),
    ...(def.last_deploy?.deployed_by ?? def.deployed_by ?? previous?.deployed_by ? { deployed_by: String(def.last_deploy?.deployed_by ?? def.deployed_by ?? previous?.deployed_by) } : {}),
    ...(retiredAt ? { retired_at: retiredAt } : {}),
    ...(def.retired_by ?? previous?.retired_by ? { retired_by: String(def.retired_by ?? previous?.retired_by) } : {}),
    ...(migratedFromStatus ? { migrated_from_status: migratedFromStatus, backfilled_at: previous?.backfilled_at ?? nowIso() } : {}),
  };
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
  const lifecycle = buildWorkflowLifecycleMetadata(next, state);
  next.lifecycle = lifecycle;
  next.validation_status = lifecycle.validation_status;
  next.deploy_version = lifecycle.deploy_version;
  if (lifecycle.deployed_at) next.deployed_at = lifecycle.deployed_at;
  else delete next.deployed_at;
  if (lifecycle.deployed_by) next.deployed_by = lifecycle.deployed_by;
  else delete next.deployed_by;
  if (lifecycle.retired_at) next.retired_at = lifecycle.retired_at;
  else delete next.retired_at;
  if (lifecycle.retired_by) next.retired_by = lifecycle.retired_by;
  else delete next.retired_by;
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

function parseWorkflowFlow(flow: unknown): { edges: FlowEdge[]; errors: ValidationError[] } {
  const errors: ValidationError[] = [];
  if (!Array.isArray(flow)) {
    return {
      edges: [],
      errors: [{
        rule: 0,
        code: "GRAPH_INVALID_FLOW_SHAPE",
        class: "graph",
        message: "Workflow flow must be an array of [from, to, condition?] edges",
      }],
    };
  }

  const edges: FlowEdge[] = [];
  for (let index = 0; index < flow.length; index += 1) {
    const raw = flow[index];
    if (!Array.isArray(raw) || raw.length < 2 || raw.length > 3) {
      errors.push({
        rule: 0,
        code: "GRAPH_INVALID_EDGE_SHAPE",
        class: "graph",
        message: `Flow edge at index ${index} must be [from, to, condition?]`,
        details: { index },
      });
      continue;
    }
    const [from, to, condition] = raw;
    if (typeof from !== "string" || from.trim() === "" || typeof to !== "string" || to.trim() === "" || (raw.length > 2 && typeof condition !== "string")) {
      errors.push({
        rule: 0,
        code: "GRAPH_INVALID_EDGE_SHAPE",
        class: "graph",
        message: `Flow edge at index ${index} must use non-empty string endpoints and optional string condition`,
        details: { index },
      });
      continue;
    }
    edges.push(raw.length > 2 ? [from, to, condition] : [from, to]);
  }

  return { edges, errors };
}

export function validateWorkflow(def: WorkflowDefinition): ValidationError[] {
  const errors: ValidationError[] = [];
  const warnings: string[] = [];
  const elements = def.elements ?? [];
  const parsedFlow = parseWorkflowFlow(def.flow);
  errors.push(...parsedFlow.errors);
  const flow = parsedFlow.edges;

  const byId = new Map<string, WorkflowElement>(elements.map(e => [e.id, e]));
  const outEdges = new Map<string, string[]>();
  const inEdges = new Map<string, string[]>();

  const seenElementIds = new Set<string>();
  const reportedDuplicateElementIds = new Set<string>();
  for (const el of elements) {
    if (seenElementIds.has(el.id) && !reportedDuplicateElementIds.has(el.id)) {
      reportedDuplicateElementIds.add(el.id);
      errors.push({
        rule: 0,
        code: "GRAPH_DUPLICATE_ELEMENT_ID",
        class: "graph",
        element_id: el.id,
        message: `Element id "${el.id}" is duplicated`,
      });
    }
    seenElementIds.add(el.id);
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
    const nonEventStartIds = startNodes.filter(n => n.type !== "event").map(n => n.id);
    errors.push({
      rule: 1,
      code: "GRAPH_NO_START_EVENT",
      class: "graph",
      message: `Process must start with an event. Non-event start nodes: ${nonEventStartIds.join(", ")}`,
      details: { non_event_start_nodes: nonEventStartIds },
    });
  }
  if (!endNodes.every(n => n.type === "event")) {
    const nonEventEndIds = endNodes.filter(n => n.type !== "event").map(n => n.id);
    errors.push({
      rule: 1,
      code: "GRAPH_INVALID_TERMINAL_STATE",
      class: "graph",
      legacy_code: "GRAPH_NO_TERMINAL_EVENT",
      message: `Process must end with an event. Non-event end nodes: ${nonEventEndIds.join(", ")}`,
      details: { non_event_terminal_nodes: nonEventEndIds },
    });
  }

  // Rule 2: Events and functions must alternate — no two events in a row (even through gateways)
  // Direct edge check: event → event is forbidden; function → function is forbidden
  for (const [from, to] of flow) {
    const fromEl = byId.get(from);
    const toEl = byId.get(to);
    if (!fromEl || !toEl) continue;
    if (fromEl.type === "event" && toEl.type === "event") {
      errors.push({
        rule: 2,
        code: "GRAPH_ALTERNATION_VIOLATION",
        class: "graph",
        message: `Event "${from}" directly connected to event "${to}" — events must be separated by a function or gateway`,
        edge: [from, to],
      });
    }
    if (fromEl.type === "function" && toEl.type === "function") {
      errors.push({
        rule: 2,
        code: "GRAPH_ALTERNATION_VIOLATION",
        class: "graph",
        message: `Function "${from}" directly connected to function "${to}" — functions must be separated by an event or gateway`,
        edge: [from, to],
      });
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
      errors.push({
        rule: 2,
        code: "GRAPH_ALTERNATION_VIOLATION",
        class: "graph",
        element_id: el.id,
        message: `Gateway "${el.id}" has function inputs and function outputs — function→gateway→function violates alternation (add an intermediate event)`,
      });
    }
  }

  // Rule 3: Roles, documents, systems must be attached only to functions (not events or gateways)
  for (const el of elements) {
    if (el.type !== "function") {
      if (el.role) errors.push({
        rule: 3,
        code: "GRAPH_METADATA_SCOPE_VIOLATION",
        class: "graph",
        element_id: el.id,
        message: `Element "${el.id}" (${el.type}) has a role — roles must only be attached to functions`,
        details: { metadata: "role" },
      });
      if (el.system) errors.push({
        rule: 3,
        code: "GRAPH_METADATA_SCOPE_VIOLATION",
        class: "graph",
        element_id: el.id,
        message: `Element "${el.id}" (${el.type}) has a system — systems must only be attached to functions`,
        details: { metadata: "system" },
      });
      if (el.documents?.length) errors.push({
        rule: 3,
        code: "GRAPH_METADATA_SCOPE_VIOLATION",
        class: "graph",
        element_id: el.id,
        message: `Element "${el.id}" (${el.type}) has documents — documents must only be attached to functions`,
        details: { metadata: "documents" },
      });
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
      errors.push({
        rule: 4,
        code: "GRAPH_GATEWAY_CONNECTIVITY_INVALID",
        class: "graph",
        element_id: el.id,
        message: `Gateway "${el.id}" is not connected to a function on either side`,
      });
    }
  }

  // Rule 5: Each function must have exactly one role (assignee)
  for (const el of elements) {
    if (el.type !== "function") continue;
    if (!el.role) {
      errors.push({
        rule: 5,
        code: "ROLE_MISSING",
        legacy_code: "RUNTIME_MISSING_ROLE",
        class: "role",
        element_id: el.id,
        message: `Function "${el.id}" ("${el.label}") has no role assigned`,
      });
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
        code: "TRIGGER_ACTIVATION_POLICY_MISSING",
        legacy_code: "DEPLOYMENT_ACTIVATION_POLICY_INVALID",
        class: "trigger",
        element_id: trigger.start_node,
        message: `Messenger start trigger "${trigger.start_node}" (${trigger.event_type}) must define activation_policy for dedup/rate/backpressure readiness`,
        details: { event_type: trigger.event_type },
      });
      continue;
    }
    if (activationPolicy) {
      errors.push(...validateActivationPolicy(activationPolicy, trigger.start_node));
    }
  }

  return errors;
}

function validationIssue(
  code: string,
  severity: WorkflowValidationSeverity,
  issueClass: WorkflowValidationClass,
  message: string,
  extras: Partial<Pick<WorkflowValidationIssue, "element_id" | "edge" | "details" | "legacy_code">> = {},
): WorkflowValidationIssue {
  return { code, severity, class: issueClass, message, ...extras };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function edgeFrom(edge: FlowEdge): string {
  return edge[0];
}

function edgeTo(edge: FlowEdge): string {
  return edge[1];
}

function edgeCondition(edge: FlowEdge): string | undefined {
  return edge.length > 2 ? edge[2] : undefined;
}

function addPayloadField(fields: Set<string>, value: unknown): void {
  if (typeof value !== "string") return;
  const field = value.trim();
  if (field) fields.add(field);
}

function addPayloadSchemaFields(fields: Set<string>, schema: unknown): void {
  if (!schema || typeof schema !== "object") return;
  const record = schema as { fields?: unknown; properties?: unknown; required?: unknown };
  if (Array.isArray(record.fields)) {
    for (const field of record.fields) addPayloadField(fields, field);
  }
  if (Array.isArray(record.required)) {
    for (const field of record.required) addPayloadField(fields, field);
  }
  if (record.properties && typeof record.properties === "object") {
    for (const field of Object.keys(record.properties as Record<string, unknown>)) addPayloadField(fields, field);
  }
}

function collectDeclaredPayloadFields(def: WorkflowDefinition): Set<string> {
  const fields = new Set<string>();
  for (const field of def.payload_fields ?? []) addPayloadField(fields, field);
  addPayloadSchemaFields(fields, def.payload_schema);
  for (const element of def.elements ?? []) {
    if (element.type !== "function") continue;
    for (const field of element.output_fields ?? []) addPayloadField(fields, field);
    addPayloadSchemaFields(fields, element.output_schema);
  }
  return fields;
}

function isDeclaredPayloadDependency(dependency: string, fields: Set<string>): boolean {
  if (fields.has(dependency)) return true;
  const topLevel = dependency.split(".")[0];
  if (fields.has(topLevel)) return true;
  for (const field of fields) {
    if (dependency.startsWith(`${field}.`)) return true;
  }
  return false;
}

function isValidDuration(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() === "") return false;
  if (parseBdDuration(value)) return true;
  try {
    return parseDurationMs(value) > 0;
  } catch {
    return false;
  }
}

function validateTriggerReadinessIssues(
  element: WorkflowElement,
  trigger: NonNullable<WorkflowElement["trigger"]>,
): WorkflowValidationIssue[] {
  const issues: WorkflowValidationIssue[] = [];
  const details: Record<string, unknown> = { kind: trigger.kind };
  const invalid = (reason: string, extra: Record<string, unknown> = {}) => {
    issues.push(validationIssue(
      "TRIGGER_READINESS_INVALID",
      "error",
      "trigger",
      `Event "${element.id}" trigger is not ready for runtime deployment: ${reason}`,
      {
        element_id: element.id,
        legacy_code: "DEPLOYMENT_TRIGGER_INVALID",
        details: { ...details, reason, ...extra },
      },
    ));
  };

  if (trigger.confidence !== undefined && (typeof trigger.confidence !== "number" || trigger.confidence < 0 || trigger.confidence > 1)) {
    invalid("confidence must be a number between 0 and 1", { field: "confidence" });
  }

  switch (trigger.kind) {
    case "timer": {
      if (typeof trigger.cron === "string" && trigger.cron.trim() !== "") {
        if (!nodeCron.validate(trigger.cron)) invalid("timer cron expression is invalid", { field: "cron", cron: trigger.cron });
        return issues;
      }
      invalid("timer trigger requires a valid cron expression; delayed triggers must use kind=delay_after", { field: "cron" });
      return issues;
    }
    case "message":
      if (typeof trigger.source !== "string" || trigger.source.trim() === "") {
        invalid("message trigger requires source", { field: "source" });
      }
      if (!isRecord(trigger.filter)) {
        invalid("message trigger requires filter object", { field: "filter" });
      }
      return issues;
    case "condition": {
      const query = trigger.query;
      if (typeof trigger.data_source !== "string" || trigger.data_source.trim() === "") {
        invalid("condition trigger requires data_source", { field: "data_source" });
      }
      if (!isRecord(query) || typeof query.entity !== "string" || query.entity.trim() === "" || !isRecord(query.filter) || typeof query.metric !== "string" || query.metric.trim() === "") {
        invalid("condition trigger requires query.entity, query.filter, and query.metric", { field: "query" });
      }
      if (!TRIGGER_CONDITION_OPERATORS.has(String(trigger.operator))) {
        invalid("condition trigger requires a supported operator", { field: "operator", operator: trigger.operator });
      }
      if (typeof trigger.threshold !== "number" || !Number.isFinite(trigger.threshold)) {
        invalid("condition trigger requires numeric threshold", { field: "threshold" });
      }
      if (!isValidDuration(trigger.poll_interval)) {
        invalid("condition trigger requires a valid poll_interval duration", { field: "poll_interval" });
      }
      return issues;
    }
    case "delay_after":
      if (!isValidDuration(trigger.duration)) {
        invalid("delay_after trigger requires a valid duration", { field: "duration" });
      }
      return issues;
    case "manual":
      if (trigger.manual_override) return issues;
      if (!TRIGGER_ACTIONS.has(String(trigger.action))) {
        invalid("manual trigger requires a supported action", { field: "action" });
      }
      if (typeof trigger.role !== "string" || trigger.role.trim() === "") {
        invalid("manual trigger requires role", { field: "role" });
      }
      return issues;
    case "system":
      if (!TRIGGER_SYSTEM_EVENTS.has(String(trigger.event_name))) {
        invalid("system trigger requires a supported event_name", { field: "event_name", event_name: trigger.event_name });
      }
      return issues;
    case "ambiguous":
      if (!Array.isArray(trigger.candidates)) {
        invalid("ambiguous trigger requires candidates array", { field: "candidates" });
      }
      return issues;
    default:
      return issues;
  }
}

function graphNodesThatCanReachTerminals(terminalIds: string[], inEdges: Map<string, FlowEdge[]>): Set<string> {
  const seen = new Set<string>();
  const stack = [...terminalIds];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const edge of inEdges.get(id) ?? []) stack.push(edgeFrom(edge));
  }
  return seen;
}

function reachableTerminalIds(startId: string, outEdges: Map<string, FlowEdge[]>, terminalEventIds: Set<string>): Set<string> {
  const terminals = new Set<string>();
  const seen = new Set<string>();
  const stack = [startId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    if (terminalEventIds.has(id)) terminals.add(id);
    for (const edge of outEdges.get(id) ?? []) stack.push(edgeTo(edge));
  }
  return terminals;
}

function stronglyConnectedComponents(nodeIds: string[], outEdges: Map<string, FlowEdge[]>): string[][] {
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indexByNode = new Map<string, number>();
  const lowlinkByNode = new Map<string, number>();
  const components: string[][] = [];
  const nodeIdSet = new Set(nodeIds);

  function visit(nodeId: string): void {
    indexByNode.set(nodeId, index);
    lowlinkByNode.set(nodeId, index);
    index += 1;
    stack.push(nodeId);
    onStack.add(nodeId);

    for (const edge of outEdges.get(nodeId) ?? []) {
      const to = edgeTo(edge);
      if (!nodeIdSet.has(to)) continue;
      if (!indexByNode.has(to)) {
        visit(to);
        lowlinkByNode.set(nodeId, Math.min(lowlinkByNode.get(nodeId)!, lowlinkByNode.get(to)!));
      } else if (onStack.has(to)) {
        lowlinkByNode.set(nodeId, Math.min(lowlinkByNode.get(nodeId)!, indexByNode.get(to)!));
      }
    }

    if (lowlinkByNode.get(nodeId) === indexByNode.get(nodeId)) {
      const component: string[] = [];
      while (stack.length > 0) {
        const member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
        if (member === nodeId) break;
      }
      components.push(component.sort());
    }
  }

  for (const nodeId of nodeIds) {
    if (!indexByNode.has(nodeId)) visit(nodeId);
  }

  return components;
}

export function validateWorkflowReadiness(
  def: WorkflowDefinition,
  context: WorkflowValidationContext = {},
): WorkflowValidationReceipt {
  const issues: WorkflowValidationIssue[] = [];
  const elements = def.elements ?? [];
  const flow = parseWorkflowFlow(def.flow).edges;
  const byId = new Map(elements.map(element => [element.id, element]));
  const outEdges = new Map<string, FlowEdge[]>();
  const inEdges = new Map<string, FlowEdge[]>();
  for (const element of elements) {
    outEdges.set(element.id, []);
    inEdges.set(element.id, []);
  }

  for (const edge of flow) {
    const from = edgeFrom(edge);
    const to = edgeTo(edge);
    const fromElement = byId.get(from);
    const toElement = byId.get(to);
    if (!fromElement || !toElement) {
      issues.push(validationIssue(
        "GRAPH_INVALID_EDGE_ENDPOINT",
        "error",
        "graph",
        `Flow edge ${from} -> ${to} references a missing element`,
        { edge, details: { missing: [!fromElement ? from : undefined, !toElement ? to : undefined].filter(Boolean) } },
      ));
      continue;
    }
    outEdges.get(from)?.push(edge);
    inEdges.get(to)?.push(edge);
  }

  const flowElements = elements.filter(element => element.type === "event" || element.type === "function" || element.type === "gateway");
  const startEvents = flowElements.filter(element => element.type === "event" && (inEdges.get(element.id)?.length ?? 0) === 0);
  const terminalEvents = flowElements.filter(element => element.type === "event" && (outEdges.get(element.id)?.length ?? 0) === 0);
  const terminalEventIds = new Set(terminalEvents.map(element => element.id));
  const startEventIds = new Set(startEvents.map(element => element.id));

  if (startEvents.length === 0) {
    issues.push(validationIssue(
      "GRAPH_NO_START_EVENT",
      "error",
      "graph",
      "Workflow must have at least one start event",
    ));
  }
  if (terminalEvents.length === 0) {
    issues.push(validationIssue(
      "GRAPH_NO_TERMINAL_EVENT",
      "error",
      "graph",
      "Workflow must have at least one terminal event",
    ));
  }

  for (const error of validateWorkflow(def)) {
    issues.push(validationIssue(
      error.code,
      "error",
      error.class,
      error.message,
      {
        element_id: error.element_id,
        edge: error.edge,
        legacy_code: error.legacy_code,
        details: { ...error.details, rule: error.rule },
      },
    ));
  }

  const reachable = new Set<string>();
  if (startEvents.length > 0) {
    const stack = startEvents.map(element => element.id);
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (reachable.has(id)) continue;
      reachable.add(id);
      for (const edge of outEdges.get(id) ?? []) stack.push(edgeTo(edge));
    }
    for (const element of flowElements) {
      if (!reachable.has(element.id)) {
        issues.push(validationIssue(
          "GRAPH_UNREACHABLE_ELEMENT",
          "error",
          "graph",
          `Element "${element.id}" is not reachable from any start event`,
          { element_id: element.id },
        ));
      }
    }
  }

  if (terminalEvents.length > 0) {
    const canReachTerminal = graphNodesThatCanReachTerminals(terminalEvents.map(element => element.id), inEdges);
    for (const element of flowElements) {
      if (reachable.has(element.id) && !canReachTerminal.has(element.id)) {
        issues.push(validationIssue(
          "GRAPH_NO_TERMINAL_PATH",
          "error",
          "graph",
          `Element "${element.id}" cannot reach any terminal event`,
          { element_id: element.id },
        ));
      }
    }
  }

  for (const cycle of stronglyConnectedComponents(flowElements.map(element => element.id), outEdges)) {
    const isCycle = cycle.length > 1 || (outEdges.get(cycle[0]) ?? []).some(edge => edgeTo(edge) === cycle[0]);
    if (!isCycle) continue;
    const hasFunctionBoundary = cycle.some(id => byId.get(id)?.type === "function");
    if (!hasFunctionBoundary) {
      issues.push(validationIssue(
        "GRAPH_UNSUPPORTED_CYCLE",
        "error",
        "graph",
        `Cycle ${cycle.join(" -> ")} has no function boundary and would spin inside runtime advancement`,
        { details: { nodes: cycle } },
      ));
    }
  }

  for (const element of flowElements) {
    if (element.type !== "gateway") continue;
    if (element.operator && element.operator !== "XOR") continue;
    const outs = outEdges.get(element.id) ?? [];
    const unconditionedTerminalBranches = outs
      .map(edge => ({ edge, terminals: reachableTerminalIds(edgeTo(edge), outEdges, terminalEventIds) }))
      .filter(branch => edgeCondition(branch.edge) === undefined && branch.terminals.size > 0);
    if (unconditionedTerminalBranches.length > 1) {
      issues.push(validationIssue(
        "GRAPH_AMBIGUOUS_TERMINAL_BRANCH",
        "error",
        "graph",
        `Gateway "${element.id}" has multiple unconditioned branches that can reach terminal events`,
        {
          element_id: element.id,
          details: {
            branches: unconditionedTerminalBranches.map(branch => ({
              to: edgeTo(branch.edge),
              terminal_events: [...branch.terminals].sort(),
            })),
          },
        },
      ));
    }
  }

  const declaredPayloadFields = collectDeclaredPayloadFields(def);
  const hasDeclaredPayloadFields = declaredPayloadFields.size > 0;

  for (const element of elements) {
    if (element.type !== "gateway") continue;
    const outs = outEdges.get(element.id) ?? [];
    if ((!element.operator || element.operator === "XOR") && outs.length > 1 && outs.every(edge => edgeCondition(edge) !== undefined)) {
      issues.push(validationIssue(
        "GRAPH_GATEWAY_MISSING_DEFAULT",
        "warning",
        "graph",
        `Gateway "${element.id}" has multiple conditional branches but no deterministic default branch`,
        { element_id: element.id, details: { outgoing_edges: outs.length } },
      ));
    }
    for (const edge of outs) {
      const condition = edgeCondition(edge);
      if (condition === undefined) continue;
      const analysis = analyzeGatewayCondition(condition);
      if (!analysis.ok) {
        issues.push(validationIssue(
          analysis.code ?? "GRAPH_INVALID_GATEWAY_CONDITION",
          "error",
          "graph",
          `Gateway "${element.id}" has an invalid outgoing condition`,
          {
            element_id: element.id,
            edge,
            details: {
              condition,
              reason: analysis.message,
              dependencies: analysis.dependencies,
              ...analysis.details,
            },
          },
        ));
        continue;
      }
      if (hasDeclaredPayloadFields) {
        for (const dependency of analysis.dependencies) {
          if (isDeclaredPayloadDependency(dependency, declaredPayloadFields)) continue;
          issues.push(validationIssue(
            "GRAPH_UNKNOWN_PAYLOAD_DEPENDENCY",
            "error",
            "graph",
            `Gateway "${element.id}" condition references unknown payload field "${dependency}"`,
            {
              element_id: element.id,
              edge,
              details: {
                condition,
                dependency,
                declared_payload_fields: [...declaredPayloadFields].sort(),
              },
            },
          ));
        }
      }
    }
  }

  const rolesById = new Map((context.roles ?? []).map(role => [role.role_id, role]));
  const roleContextProvided = context.roles !== undefined;
  const seededDocIds = new Set((def.documents ?? []).map(doc => doc.doc_id));
  const knownDocIds = new Set([...(context.documents ?? []).map(doc => doc.doc_id), ...seededDocIds]);
  const adapterNames = new Set(context.adapters ?? []);
  const adapterContextProvided = context.adapters !== undefined;
  const supportedTriggers = new Set(["timer", "message", "condition", "delay_after", "system", "manual"]);
  const deployReadiness = context.source === "workflow.deploy";

  for (const element of elements) {
    if (element.type === "function") {
      if (element.role && roleContextProvided) {
        const role = rolesById.get(element.role);
        if (!role) {
          issues.push(validationIssue(
            "ROLE_MISSING",
            "error",
            "role",
            `Function "${element.id}" references missing role "${element.role}"`,
            { element_id: element.id, legacy_code: "RUNTIME_MISSING_ROLE", details: { role: element.role } },
          ));
        } else if (role.strategy !== "manual" && (role.assignees ?? []).length === 0) {
          issues.push(validationIssue(
            "ROLE_MISSING_ASSIGNEE",
            "error",
            "role",
            `Role "${element.role}" has no assignees and is not manual`,
            { element_id: element.id, legacy_code: "RUNTIME_MISSING_ROLE_ASSIGNEE", details: { role: element.role, strategy: role.strategy } },
          ));
        }
      }

      for (const rawDocId of element.documents ?? []) {
        if (typeof rawDocId !== "string" || rawDocId.trim() === "") {
          issues.push(validationIssue(
            "DOCUMENT_BINDING_INVALID",
            "error",
            "document",
            `Function "${element.id}" has an invalid document binding`,
            { element_id: element.id, legacy_code: "RUNTIME_INVALID_DOCUMENT_BINDING", details: { document: rawDocId } },
          ));
          continue;
        }
        const docId = rawDocId.trim();
        if (!knownDocIds.has(docId)) {
          issues.push(validationIssue(
            "DOCUMENT_MISSING",
            "error",
            "document",
            `Function "${element.id}" references missing document "${docId}"`,
            { element_id: element.id, legacy_code: "RUNTIME_MISSING_DOCUMENT", details: { document: docId } },
          ));
        }
      }

      const legacySystemBinding = Object.prototype.hasOwnProperty.call(element, "system")
        ? [{ connector: (element as { system?: unknown }).system }]
        : [];
      const systems: unknown[] = [
        ...legacySystemBinding,
        ...(element.systems ?? []),
      ];
      for (const system of systems) {
        if (!isRecord(system) || typeof system.connector !== "string" || system.connector.trim() === "") {
          issues.push(validationIssue(
            "ADAPTER_BINDING_INVALID",
            "error",
            "adapter",
            `Function "${element.id}" has an invalid adapter binding`,
            { element_id: element.id, legacy_code: "RUNTIME_INVALID_ADAPTER_BINDING", details: { system } },
          ));
          continue;
        }
        const connector = system.connector.trim();
        const operation = typeof system.operation === "string" ? system.operation : undefined;
        if (adapterContextProvided && !adapterNames.has(connector)) {
          issues.push(validationIssue(
            "ADAPTER_MISSING",
            "error",
            "adapter",
            `Function "${element.id}" references missing adapter "${connector}"`,
            { element_id: element.id, legacy_code: "RUNTIME_MISSING_ADAPTER", details: { connector, operation } },
          ));
        }
      }
    }

    if (element.type === "event" && element.trigger?.kind) {
      if (element.trigger.kind === "ambiguous") {
        issues.push(validationIssue(
          "TRIGGER_AMBIGUOUS",
          "error",
          "trigger",
          `Event "${element.id}" trigger is ambiguous and requires manual override`,
          { element_id: element.id, legacy_code: "DEPLOYMENT_AMBIGUOUS_TRIGGER" },
        ));
      } else if ((element.trigger.confidence ?? 1) < 0.7) {
        issues.push(validationIssue(
          "DEPLOYMENT_TRIGGER_REVIEW_REQUIRED",
          "error",
          "deployment",
          `Event "${element.id}" trigger confidence is below deployment threshold and requires manual review`,
          { element_id: element.id, details: { confidence: element.trigger.confidence } },
        ));
      } else if (!supportedTriggers.has(element.trigger.kind)) {
        issues.push(validationIssue(
          "TRIGGER_UNSUPPORTED_KIND",
          "error",
          "trigger",
          `Event "${element.id}" uses unsupported trigger kind "${element.trigger.kind}"`,
          { element_id: element.id, legacy_code: "DEPLOYMENT_UNSUPPORTED_TRIGGER", details: { kind: element.trigger.kind } },
        ));
      } else {
        issues.push(...validateTriggerReadinessIssues(element, element.trigger));
      }
      if (terminalEventIds.has(element.id) && !startEventIds.has(element.id) && !element.trigger.manual_override) {
        issues.push(validationIssue(
          "DEPLOYMENT_TERMINAL_EVENT_HAS_TRIGGER",
          "error",
          "deployment",
          `Terminal event "${element.id}" must not materialize waits or subscriptions`,
          { element_id: element.id },
        ));
      }
    }

    if (element.type === "event" && startEventIds.has(element.id) && !element.trigger?.kind && !element.trigger?.manual_override) {
      issues.push(validationIssue(
        "DEPLOYMENT_START_TRIGGER_UNRESOLVED",
        deployReadiness ? "error" : "warning",
        "deployment",
        `Start event "${element.id}" has no materialized trigger`,
        { element_id: element.id },
      ));
    }
  }

  if ((context.running_case_count ?? 0) > 0) {
    issues.push(validationIssue(
      "MIGRATION_RUNNING_CASES_PRESENT",
      "warning",
      "migration",
      "Workflow has running cases; incompatible schema changes require migration review",
      { details: { running_case_count: context.running_case_count } },
    ));
  }

  const errors = issues.filter(issue => issue.severity === "error");
  const warnings = issues.filter(issue => issue.severity === "warning");
  const readiness: WorkflowReadiness = errors.length > 0 ? "blocked" : warnings.length > 0 ? "warning" : "ready";
  return {
    workflow_id: def.id,
    taxonomy_version: WORKFLOW_VALIDATION_TAXONOMY_VERSION,
    readiness,
    source: context.source ?? "workflow.validate",
    errors,
    warnings,
    checked_at: nowIso(),
    gates: {
      deployment_blocker: errors.some(issue => issue.class !== "migration"),
      case_start_blocker: errors.some(issue => issue.class === "graph" || issue.class === "role" || issue.class === "trigger" || issue.class === "adapter" || issue.class === "document" || issue.class === "deployment" || issue.class === "lifecycle"),
      release_blocker: errors.length > 0,
      reviewer_required: warnings.length > 0 || errors.some(issue => issue.class === "migration"),
    },
  };
}

function validateActivationPolicy(policy: WorkflowActivationPolicy, startNode: string): ValidationError[] {
  const errors: ValidationError[] = [];
  const prefix = `Activation policy for start trigger "${startNode}"`;
  if (policy.min_confidence !== undefined && (typeof policy.min_confidence !== "number" || policy.min_confidence < 0 || policy.min_confidence > 1)) {
    errors.push({
      rule: 7,
      code: "TRIGGER_ACTIVATION_POLICY_INVALID",
      legacy_code: "DEPLOYMENT_ACTIVATION_POLICY_INVALID",
      class: "trigger",
      element_id: startNode,
      message: `${prefix} has invalid min_confidence; expected number between 0 and 1`,
      details: { field: "min_confidence" },
    });
  }
  if (policy.dedup_window_sec !== undefined && (!Number.isFinite(policy.dedup_window_sec) || policy.dedup_window_sec <= 0)) {
    errors.push({
      rule: 7,
      code: "TRIGGER_ACTIVATION_POLICY_INVALID",
      legacy_code: "DEPLOYMENT_ACTIVATION_POLICY_INVALID",
      class: "trigger",
      element_id: startNode,
      message: `${prefix} has invalid dedup_window_sec; expected positive seconds`,
      details: { field: "dedup_window_sec" },
    });
  }
  if (policy.rate_limit) {
    if (!Number.isFinite(policy.rate_limit.window_sec) || policy.rate_limit.window_sec <= 0) {
      errors.push({
        rule: 7,
        code: "TRIGGER_ACTIVATION_POLICY_INVALID",
        legacy_code: "DEPLOYMENT_ACTIVATION_POLICY_INVALID",
        class: "trigger",
        element_id: startNode,
        message: `${prefix} has invalid rate_limit.window_sec; expected positive seconds`,
        details: { field: "rate_limit.window_sec" },
      });
    }
    if (!Number.isFinite(policy.rate_limit.max_events) || policy.rate_limit.max_events <= 0) {
      errors.push({
        rule: 7,
        code: "TRIGGER_ACTIVATION_POLICY_INVALID",
        legacy_code: "DEPLOYMENT_ACTIVATION_POLICY_INVALID",
        class: "trigger",
        element_id: startNode,
        message: `${prefix} has invalid rate_limit.max_events; expected positive count`,
        details: { field: "rate_limit.max_events" },
      });
    }
  }
  if (policy.backpressure?.max_running_cases !== undefined && (!Number.isFinite(policy.backpressure.max_running_cases) || policy.backpressure.max_running_cases <= 0)) {
    errors.push({
      rule: 7,
      code: "TRIGGER_ACTIVATION_POLICY_INVALID",
      legacy_code: "DEPLOYMENT_ACTIVATION_POLICY_INVALID",
      class: "trigger",
      element_id: startNode,
      message: `${prefix} has invalid backpressure.max_running_cases; expected positive count`,
      details: { field: "backpressure.max_running_cases" },
    });
  }
  if (policy.sampling && (typeof policy.sampling.rate !== "number" || policy.sampling.rate < 0 || policy.sampling.rate > 1)) {
    errors.push({
      rule: 7,
      code: "TRIGGER_ACTIVATION_POLICY_INVALID",
      legacy_code: "DEPLOYMENT_ACTIVATION_POLICY_INVALID",
      class: "trigger",
      element_id: startNode,
      message: `${prefix} has invalid sampling.rate; expected number between 0 and 1`,
      details: { field: "sampling.rate" },
    });
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
  const lifecycle = buildWorkflowLifecycleMetadata(normalized, lifecycle_state);
  return {
    ...normalized,
    status: lifecycle_state,
    lifecycle_state,
    lifecycle,
    validation_status: lifecycle.validation_status,
    deploy_version: lifecycle.deploy_version,
    deployed_at: lifecycle.deployed_at,
    deployed_by: lifecycle.deployed_by,
    retired_at: lifecycle.retired_at,
    retired_by: lifecycle.retired_by,
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
const WORKFLOW_DEPLOYED_SNAPSHOT_KEY_PREFIX = "workflow:deployed:"; // workflow:deployed:{id}:v{deployVersion}
const WORKFLOW_CAS_MAX_RETRIES = 16;

function workflowDeployedSnapshotKey(id: string, deployVersion: number): string {
  return `${WORKFLOW_DEPLOYED_SNAPSHOT_KEY_PREFIX}${id}:v${deployVersion}`;
}

function workflowDeployedSnapshotNum(deployVersion: number): number {
  return -deployVersion - 1;
}

export async function saveWorkflowDeployedSnapshot(
  def: WorkflowDefinition,
  source = def.last_deploy?.source ?? "workflow.deploy",
): Promise<WorkflowRuntimeSnapshotBinding> {
  const normalized = normalizeWorkflow(def);
  const deployVersion = getWorkflowDeployVersion(normalized);
  const snapshotKey = workflowDeployedSnapshotKey(normalized.id, deployVersion);
  const boundAt = nowIso();
  const snapshot = {
    ...normalized,
    saved_at: boundAt,
    runtime_snapshot: {
      workflow_id: normalized.id,
      deploy_version: deployVersion,
      source,
      snapshot_key: snapshotKey,
    },
  };
  await redis.set(snapshotKey, JSON.stringify(snapshot), "NX");
  await pgSaveWorkflowSnapshot(normalized.id, workflowDeployedSnapshotNum(deployVersion), snapshot as any);
  return {
    workflow_id: normalized.id,
    deploy_version: deployVersion,
    snapshot_key: snapshotKey,
    bound_at: boundAt,
    source,
  };
}

export async function getWorkflowDeployedSnapshot(binding: WorkflowRuntimeSnapshotBinding): Promise<WorkflowDefinition | null> {
  if (binding.workflow_id && binding.snapshot_key) {
    const raw = await redis.get(binding.snapshot_key);
    if (raw) return normalizeWorkflow(JSON.parse(raw));
  }
  const key = workflowDeployedSnapshotKey(binding.workflow_id, binding.deploy_version);
  const raw = await redis.get(key);
  if (raw) return normalizeWorkflow(JSON.parse(raw));

  const row = await pgGetWorkflowSnapshot(binding.workflow_id, workflowDeployedSnapshotNum(binding.deploy_version));
  return row ? normalizeWorkflow(row as unknown as WorkflowDefinition) : null;
}

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
        validation: validationMetadata([], opts.source ?? "workflow.update", "skipped"),
        clearDeploy: true,
      }),
      errors: [],
      persistable: true,
    };
  }

  const errors = validateWorkflow(normalized);
  const validation = validationMetadata(errors, opts.source ?? (opts.lifecycleState === "executable" ? "workflow.deploy" : "workflow.update"));
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

export async function archiveWorkflow(id: string, opts: WorkflowArchiveOptions = {}): Promise<boolean> {
  const raw = await redis.get(WORKFLOW_KEY_PREFIX + id);
  if (!raw) return false;
  const def = normalizeWorkflow(JSON.parse(raw));
  const retiredAt = nowIso();
  const source = opts.source ?? "workflow.delete";
  const retiredBy = opts.retiredBy ?? source;
  const retired = withLifecycle(
    {
      ...def,
      retired_at: retiredAt,
      retired_by: retiredBy,
    },
    "retired",
    {
      deploy: {
        status: "retired",
        checked_at: retiredAt,
        source,
        details: ["workflow archived and retired from new case starts"],
      },
      needsReview: false,
    },
  );
  await archiveWorkflowSnapshot(id, def);
  await redis.set(WORKFLOW_KEY_PREFIX + id, JSON.stringify(retired));
  await redis.srem(WORKFLOW_INDEX_KEY, id);
  await removeFromRoleWorkflowIndex(retired);
  // Emit orphan warnings for roles/docs that were exclusive to this workflow
  cleanupWorkflowRefs(retired).catch(e => log.error("schema-sync archiveWorkflow cleanup error", { error: e instanceof Error ? e.message : String(e) }));
  await pgUpsertWorkflow(retired as any);
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
