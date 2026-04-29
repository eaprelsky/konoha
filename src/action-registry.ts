/**
 * action-registry.ts — Unified action vocabulary and registry (#499)
 *
 * A single, versioned source of truth for every action the system exposes.
 * Used by API, MCP, assistant, and UI layers.
 *
 * Design principles:
 *   - Object-scope naming: `{object}.{verb}` (e.g. `workflow.create`)
 *   - Every action has an explicit argument contract
 *   - Registry is frozen at startup — actions are registered declaratively
 *   - Versioned: bump ACTION_VERSION when the vocabulary changes
 */

import { classifyAction, getActionSecurity, type ActionCategory, type ActionSecurityPolicy } from "./action-policy";
export { classifyAction, getActionSecurity } from "./action-policy";
export type { ActionActorPolicy, ActionCategory, ActionSecurityPolicy } from "./action-policy";

// ── Version ─────────────────────────────────────────────────────────────────

export const ACTION_VERSION = 2;

// ── Core types ──────────────────────────────────────────────────────────────

export type ObjectScope =
  | "workflow"    // process definitions
  | "element"     // nodes inside a workflow (event, function, gateway)
  | "flow"        // edges between elements
  | "trigger"     // event subscriptions and trigger configuration
  | "case"        // running process instances
  | "workitem"    // dispatched work items
  | "role"        // role definitions and assignments
  | "agent"       // agent lifecycle (register, start, stop, restart)
  | "skill"       // skill CRUD
  | "person"      // people directory
  | "access"      // trusted users and Telegram group access
  | "adapter"     // data adapter operations
  | "reminder"    // scheduled reminders
  | "issue"       // GitHub issue operations
  | "subscription"// event manager subscriptions
  | "audit"       // audit log reads
  | "knowledge"   // knowledge base operations
  | "message";    // bus messages

export type AutonomyLevel = "auto" | "confirm" | "disabled";
export type ActionImplementationKind = "direct" | "endpoint" | "registered-handler" | "planned";

export interface ActionImplementation {
  kind: ActionImplementationKind;
  /** Short migration note for planned/legacy implementations. */
  note?: string;
}

export interface ArgumentDef {
  name: string;
  type: "string" | "number" | "boolean" | "object" | "array" | "date";
  required: boolean;
  description: string;
}

export interface ActionDef {
  /** Unique dotted name: `{scope}.{verb}` */
  id: string;
  /** Human-readable summary */
  description: string;
  /** Object scope this action belongs to */
  scope: ObjectScope;
  /** Argument contract */
  args: ArgumentDef[];
  /** Current HTTP method + path that handles this action (for migration tracking) */
  currentEndpoint?: string;
  /** Explicit implementation metadata when currentEndpoint is not sufficient. */
  implementation?: ActionImplementation;
  /** Actor policy enforced by /act. If omitted, inferred from scope/category. */
  security?: ActionSecurityPolicy;
  /** Default autonomy level */
  autonomy: AutonomyLevel;
  /** Whether this action writes to the audit log */
  audited: boolean;
}

export interface ActionSurfaceEntry extends ActionDef {
  category: ActionCategory;
  implementation: ActionImplementation;
  security: ActionSecurityPolicy;
  implemented: boolean;
}

// ── Action definitions ──────────────────────────────────────────────────────

const ACTIONS: ActionDef[] = [
  // ── Workflow ──────────────────────────────────────────────────────────────
  {
    id: "workflow.create",
    description: "Create a new workflow (process definition). Accepts draft or deployed state.",
    scope: "workflow",
    args: [
      { name: "id",          type: "string",  required: false, description: "Workflow ID. Auto-generated if omitted." },
      { name: "name",        type: "string",  required: false, description: "Human-readable name." },
      { name: "elements",    type: "array",   required: true,  description: "Array of WorkflowElement objects." },
      { name: "flow",        type: "array",   required: true,  description: "Array of FlowEdge tuples [from, to, condition?]." },
      { name: "draft",       type: "boolean", required: false, description: "Save as draft (skip trigger resolution)." },
      { name: "description", type: "string",  required: false, description: "Optional description." },
    ],
    currentEndpoint: "POST /workflows",
    autonomy: "confirm",
    audited: true,
  },
  {
    id: "workflow.update",
    description: "Update an existing workflow definition.",
    scope: "workflow",
    args: [
      { name: "id",          type: "string",  required: true,  description: "Workflow ID to update." },
      { name: "name",        type: "string",  required: false, description: "New name." },
      { name: "elements",    type: "array",   required: false, description: "Updated elements array." },
      { name: "flow",        type: "array",   required: false, description: "Updated flow edges." },
      { name: "draft",       type: "boolean", required: false, description: "Save as draft." },
    ],
    currentEndpoint: "PUT /workflows/:id",
    autonomy: "confirm",
    audited: true,
  },
  {
    id: "workflow.delete",
    description: "Archive a workflow and cascade-delete its cases.",
    scope: "workflow",
    args: [
      { name: "id", type: "string", required: true, description: "Workflow ID to archive." },
    ],
    currentEndpoint: "DELETE /workflows/:id",
    autonomy: "confirm",
    audited: true,
  },
  {
    id: "workflow.list",
    description: "List all workflow definitions.",
    scope: "workflow",
    args: [],
    currentEndpoint: "GET /workflows",
    autonomy: "auto",
    audited: false,
  },
  {
    id: "workflow.get",
    description: "Get a single workflow definition by ID, optionally at a specific snapshot.",
    scope: "workflow",
    args: [
      { name: "id",       type: "string", required: true,  description: "Workflow ID." },
      { name: "snapshot", type: "string", required: false, description: "Snapshot version to load." },
    ],
    currentEndpoint: "GET /workflows/:id",
    autonomy: "auto",
    audited: false,
  },

  // ── Element ───────────────────────────────────────────────────────────────
  {
    id: "element.add",
    description: "Add a single element to a workflow. Updates the workflow's elements array.",
    scope: "element",
    args: [
      { name: "workflow_id", type: "string", required: true,  description: "Target workflow ID." },
      { name: "id",          type: "string", required: true,  description: "Element ID (unique within workflow)." },
      { name: "type",        type: "string", required: true,  description: "Element type: event | function | gateway." },
      { name: "label",       type: "string", required: true,  description: "Human-readable label." },
      { name: "role",        type: "string", required: false, description: "Assigned role (for functions)." },
      { name: "operator",    type: "string", required: false, description: "Gateway operator: AND | OR | XOR." },
    ],
    implementation: { kind: "planned", note: "Intent decomposer emits this action; direct workflow patch executor is not wired yet." },
    autonomy: "confirm",
    audited: true,
  },
  {
    id: "element.update",
    description: "Update properties of an existing element in a workflow.",
    scope: "element",
    args: [
      { name: "workflow_id", type: "string", required: true,  description: "Workflow ID." },
      { name: "id",          type: "string", required: true,  description: "Element ID to update." },
      { name: "label",       type: "string", required: false, description: "New label." },
      { name: "role",        type: "string", required: false, description: "New role assignment." },
      { name: "trigger",     type: "object", required: false, description: "Trigger configuration (for event nodes)." },
    ],
    implementation: { kind: "planned", note: "Intent decomposer emits this action; direct workflow patch executor is not wired yet." },
    autonomy: "confirm",
    audited: true,
  },
  {
    id: "element.remove",
    description: "Remove an element and its connected edges from a workflow.",
    scope: "element",
    args: [
      { name: "workflow_id", type: "string", required: true, description: "Workflow ID." },
      { name: "id",          type: "string", required: true, description: "Element ID to remove." },
    ],
    implementation: { kind: "planned", note: "Intent decomposer emits this action; direct workflow patch executor is not wired yet." },
    autonomy: "confirm",
    audited: true,
  },

  // ── Flow ──────────────────────────────────────────────────────────────────
  {
    id: "flow.add",
    description: "Add an edge between two elements in a workflow.",
    scope: "flow",
    args: [
      { name: "workflow_id", type: "string", required: true,  description: "Workflow ID." },
      { name: "from",        type: "string", required: true,  description: "Source element ID." },
      { name: "to",          type: "string", required: true,  description: "Target element ID." },
      { name: "condition",   type: "string", required: false, description: "JS expression for conditional routing." },
    ],
    implementation: { kind: "planned", note: "Intent decomposer emits this action; direct workflow patch executor is not wired yet." },
    autonomy: "confirm",
    audited: true,
  },
  {
    id: "flow.remove",
    description: "Remove an edge between two elements.",
    scope: "flow",
    args: [
      { name: "workflow_id", type: "string", required: true,  description: "Workflow ID." },
      { name: "from",        type: "string", required: true,  description: "Source element ID." },
      { name: "to",          type: "string", required: true,  description: "Target element ID." },
    ],
    implementation: { kind: "planned", note: "Intent decomposer emits this action; direct workflow patch executor is not wired yet." },
    autonomy: "confirm",
    audited: true,
  },

  // ── Trigger ───────────────────────────────────────────────────────────────
  {
    id: "trigger.set",
    description: "Set or update the trigger configuration on an event element.",
    scope: "trigger",
    args: [
      { name: "workflow_id", type: "string", required: true,  description: "Workflow ID." },
      { name: "element_id",  type: "string", required: true,  description: "Event element ID." },
      { name: "kind",        type: "string", required: true,  description: "Trigger kind: timer | message | condition | system | manual." },
      { name: "config",      type: "object", required: false, description: "Kind-specific trigger configuration." },
    ],
    implementation: { kind: "planned", note: "Trigger mutation action exists in the vocabulary but is not wired to executor yet." },
    autonomy: "confirm",
    audited: true,
  },
  {
    id: "trigger.resolve",
    description: "Run trigger resolver on an event element to auto-detect its trigger kind.",
    scope: "trigger",
    args: [
      { name: "workflow_id", type: "string", required: true, description: "Workflow ID." },
      { name: "element_id",  type: "string", required: true, description: "Event element ID to resolve." },
    ],
    implementation: { kind: "planned", note: "Trigger resolver action exists in the vocabulary but is not wired to executor yet." },
    autonomy: "auto",
    audited: true,
  },

  // ── Case ──────────────────────────────────────────────────────────────────
  {
    id: "case.start",
    description: "Start a new case (running instance) from a workflow definition.",
    scope: "case",
    args: [
      { name: "process_id", type: "string",  required: true,  description: "Workflow ID to instantiate." },
      { name: "subject",    type: "string",  required: true,  description: "Case subject / title." },
      { name: "payload",    type: "object",  required: false, description: "Initial case data." },
      { name: "start_node", type: "string",  required: false, description: "Override start element ID." },
    ],
    currentEndpoint: "POST /cases",
    autonomy: "auto",
    audited: true,
  },
  {
    id: "case.get",
    description: "Get case details by ID.",
    scope: "case",
    args: [
      { name: "id", type: "string", required: true, description: "Case ID." },
    ],
    currentEndpoint: "GET /cases/:id",
    autonomy: "auto",
    audited: false,
  },
  {
    id: "case.list",
    description: "List cases with optional filters.",
    scope: "case",
    args: [
      { name: "status",     type: "string", required: false, description: "Filter by status: running | done | error." },
      { name: "process_id", type: "string", required: false, description: "Filter by workflow ID." },
      { name: "limit",      type: "number", required: false, description: "Max results (default 50, max 2000)." },
      { name: "offset",     type: "number", required: false, description: "Pagination offset." },
    ],
    currentEndpoint: "GET /cases",
    autonomy: "auto",
    audited: false,
  },
  {
    id: "case.close",
    description: "Force-close a running case.",
    scope: "case",
    args: [
      { name: "id", type: "string", required: true, description: "Case ID to close." },
    ],
    currentEndpoint: "POST /cases/:id/close",
    autonomy: "confirm",
    audited: true,
  },

  // ── Work Item ─────────────────────────────────────────────────────────────
  {
    id: "workitem.complete",
    description: "Complete a dispatched work item, providing output data.",
    scope: "workitem",
    args: [
      { name: "id",     type: "string", required: true,  description: "Work item ID." },
      { name: "output", type: "object", required: false, description: "Output data from task execution." },
    ],
    currentEndpoint: "POST /workitems/:id/complete",
    autonomy: "auto",
    audited: true,
  },
  {
    id: "workitem.create",
    description: "Create a standalone work item (not tied to a case).",
    scope: "workitem",
    args: [
      { name: "label",    type: "string", required: true,  description: "Work item title." },
      { name: "assignee", type: "string", required: true,  description: "Role or agent ID to assign to." },
      { name: "input",    type: "object", required: false, description: "Input data." },
      { name: "deadline", type: "string", required: false, description: "ISO 8601 deadline." },
      { name: "process_id", type: "string", required: false, description: "Optional workflow/process ID for standalone work item grouping." },
    ],
    currentEndpoint: "POST /workitems",
    autonomy: "auto",
    audited: true,
  },
  {
    id: "workitem.update",
    description: "Update work item status, assignee, deadline, or output.",
    scope: "workitem",
    args: [
      { name: "id",       type: "string", required: true,  description: "Work item ID." },
      { name: "status",   type: "string", required: false, description: "New status." },
      { name: "assignee", type: "string", required: false, description: "New assignee." },
      { name: "deadline", type: "string", required: false, description: "New deadline." },
      { name: "output",   type: "object", required: false, description: "Output data." },
      { name: "label",    type: "string", required: false, description: "New work item label." },
    ],
    currentEndpoint: "PATCH /workitems/:id",
    autonomy: "auto",
    audited: true,
  },
  {
    id: "workitem.list",
    description: "List work items with optional filters.",
    scope: "workitem",
    args: [
      { name: "assignee",       type: "string", required: false, description: "Filter by assignee." },
      { name: "status",         type: "string", required: false, description: "Filter by status." },
      { name: "process_id",     type: "string", required: false, description: "Filter by workflow ID." },
      { name: "deadline_before", type: "string", required: false, description: "Only items due before this date." },
    ],
    currentEndpoint: "GET /workitems",
    autonomy: "auto",
    audited: false,
  },
  {
    id: "workitem.cancel",
    description: "Cancel a work item.",
    scope: "workitem",
    args: [
      { name: "id", type: "string", required: true, description: "Work item ID to cancel." },
    ],
    currentEndpoint: "DELETE /workitems/:id",
    autonomy: "auto",
    audited: true,
  },

  // ── Role ──────────────────────────────────────────────────────────────────
  {
    id: "role.create",
    description: "Create a new role definition.",
    scope: "role",
    args: [
      { name: "role_id",     type: "string", required: true,  description: "Unique role identifier." },
      { name: "name",        type: "string", required: true,  description: "Display name." },
      { name: "description", type: "string", required: false, description: "Role description." },
      { name: "assignees",   type: "array",  required: false, description: "Initial role assignee IDs." },
      { name: "strategy",    type: "string", required: false, description: "Assignment strategy." },
    ],
    currentEndpoint: "POST /roles",
    autonomy: "confirm",
    audited: true,
  },
  {
    id: "role.list",
    description: "List all roles.",
    scope: "role",
    args: [],
    currentEndpoint: "GET /roles",
    autonomy: "auto",
    audited: false,
  },
  {
    id: "role.update",
    description: "Update a role definition.",
    scope: "role",
    args: [
      { name: "id",          type: "string", required: true,  description: "Role ID." },
      { name: "name",        type: "string", required: false, description: "New display name." },
      { name: "description", type: "string", required: false, description: "New description." },
      { name: "assignees",   type: "array",  required: false, description: "Updated role assignee IDs." },
      { name: "strategy",    type: "string", required: false, description: "New assignment strategy." },
    ],
    currentEndpoint: "PATCH /roles/:id",
    autonomy: "confirm",
    audited: true,
  },
  {
    id: "role.delete",
    description: "Delete a role definition.",
    scope: "role",
    args: [
      { name: "id", type: "string", required: true, description: "Role ID to delete." },
    ],
    currentEndpoint: "DELETE /roles/:id",
    autonomy: "confirm",
    audited: true,
  },

  // ── Agent ─────────────────────────────────────────────────────────────────
  {
    id: "agent.register",
    description: "Register an agent on the bus.",
    scope: "agent",
    args: [
      { name: "id",            type: "string", required: true,  description: "Unique agent ID." },
      { name: "name",          type: "string", required: true,  description: "Display name." },
      { name: "roles",         type: "array",  required: false, description: "Role list." },
      { name: "capabilities",  type: "array",  required: false, description: "Capability list." },
      { name: "model",         type: "string", required: false, description: "Model identifier." },
    ],
    currentEndpoint: "POST /agents/register",
    autonomy: "auto",
    audited: true,
  },
  {
    id: "agent.start",
    description: "Start a stopped agent (creates tmux session).",
    scope: "agent",
    args: [
      { name: "id", type: "string", required: true, description: "Agent ID to start." },
    ],
    currentEndpoint: "POST /agents/:id/start",
    autonomy: "confirm",
    audited: true,
  },
  {
    id: "agent.stop",
    description: "Stop a running agent.",
    scope: "agent",
    args: [
      { name: "id", type: "string", required: true, description: "Agent ID to stop." },
    ],
    currentEndpoint: "POST /agents/:id/stop",
    autonomy: "confirm",
    audited: true,
  },
  {
    id: "agent.restart",
    description: "Restart an agent (stop + start, regenerates config).",
    scope: "agent",
    args: [
      { name: "id", type: "string", required: true, description: "Agent ID to restart." },
    ],
    currentEndpoint: "POST /agents/:id/restart",
    autonomy: "confirm",
    audited: true,
  },

  // ── Person Directory ──────────────────────────────────────────────────────
  {
    id: "person.list",
    description: "List people from trusted-users file and custom dashboard records.",
    scope: "person",
    args: [],
    currentEndpoint: "GET /people",
    autonomy: "auto",
    audited: false,
  },
  {
    id: "person.upsert",
    description: "Create or update a custom person record. File-backed trusted users cannot be overridden.",
    scope: "person",
    args: [
      { name: "id",             type: "string", required: false, description: "Stable person ID. Generated from name if omitted." },
      { name: "name",           type: "string", required: true,  description: "Display name." },
      { name: "tg_id",          type: "number", required: false, description: "Telegram numeric user ID." },
      { name: "tg_username",    type: "string", required: false, description: "Telegram username without @." },
      { name: "position",       type: "string", required: false, description: "Role or job title." },
      { name: "email",          type: "string", required: false, description: "Email address." },
      { name: "bitrix24_id",    type: "string", required: false, description: "Bitrix24 user ID." },
      { name: "tracker_login",  type: "string", required: false, description: "Yandex Tracker login." },
      { name: "yonote_id",      type: "string", required: false, description: "Yonote user ID." },
      { name: "channel",        type: "string", required: false, description: "Preferred notification channel: telegram | email." },
      { name: "capabilities",   type: "array",  required: false, description: "Capability/skill IDs." },
      { name: "avatar_url",     type: "string", required: false, description: "Avatar URL." },
    ],
    currentEndpoint: "POST /people",
    autonomy: "confirm",
    audited: true,
  },
  {
    id: "person.delete",
    description: "Delete a custom person record. File-backed trusted users cannot be deleted here.",
    scope: "person",
    args: [
      { name: "id", type: "string", required: true, description: "Person ID to delete." },
    ],
    currentEndpoint: "DELETE /people/:id",
    autonomy: "confirm",
    audited: true,
  },

  // ── Access Control ────────────────────────────────────────────────────────
  {
    id: "access.list",
    description: "List owner, trusted users, whitelisted Telegram groups, and pending access requests.",
    scope: "access",
    args: [],
    currentEndpoint: "GET /whitelist",
    autonomy: "auto",
    audited: false,
  },
  {
    id: "access.approve",
    description: "Approve a pending user or group access request.",
    scope: "access",
    args: [
      { name: "type",        type: "string", required: true,  description: "Entry type: user | group." },
      { name: "telegram_id", type: "number", required: false, description: "Telegram user ID for user approvals." },
      { name: "chat_id",     type: "number", required: false, description: "Telegram chat ID for group approvals." },
    ],
    currentEndpoint: "POST /whitelist/approve",
    autonomy: "confirm",
    audited: true,
  },
  {
    id: "access.reject",
    description: "Reject a pending user or group access request, optionally blocking it.",
    scope: "access",
    args: [
      { name: "type",        type: "string",  required: true,  description: "Entry type: user | group." },
      { name: "telegram_id", type: "number",  required: false, description: "Telegram user ID for user rejections." },
      { name: "chat_id",     type: "number",  required: false, description: "Telegram chat ID for group rejections." },
      { name: "block",       type: "boolean", required: false, description: "Add ID to blocked list." },
    ],
    currentEndpoint: "POST /whitelist/reject",
    autonomy: "confirm",
    audited: true,
  },
  {
    id: "access.upsert_user",
    description: "Create or update a trusted Telegram user in the file-backed access list.",
    scope: "access",
    args: [
      { name: "name",        type: "string", required: true,  description: "Display name." },
      { name: "telegram_id", type: "number", required: true,  description: "Telegram numeric user ID." },
      { name: "username",    type: "string", required: false, description: "Telegram username without @." },
      { name: "email",       type: "string", required: false, description: "Email address." },
      { name: "phone",       type: "string", required: false, description: "Phone number." },
      { name: "position",    type: "string", required: false, description: "Role or job title." },
      { name: "relation",    type: "string", required: false, description: "Relation/group label." },
      { name: "level",       type: "number", required: false, description: "Trust level." },
    ],
    currentEndpoint: "POST /whitelist/user",
    autonomy: "confirm",
    audited: true,
  },
  {
    id: "access.remove_user",
    description: "Remove a trusted Telegram user from the access list.",
    scope: "access",
    args: [
      { name: "telegram_id", type: "number", required: true, description: "Telegram numeric user ID." },
    ],
    currentEndpoint: "DELETE /whitelist/user/:telegram_id",
    autonomy: "confirm",
    audited: true,
  },
  {
    id: "access.add_group",
    description: "Add a Telegram group to the whitelist.",
    scope: "access",
    args: [
      { name: "chat_id", type: "number", required: true, description: "Telegram chat ID." },
    ],
    currentEndpoint: "POST /whitelist/group",
    autonomy: "confirm",
    audited: true,
  },
  {
    id: "access.remove_group",
    description: "Remove a Telegram group from the whitelist.",
    scope: "access",
    args: [
      { name: "chat_id", type: "number", required: true, description: "Telegram chat ID." },
    ],
    currentEndpoint: "DELETE /whitelist/group/:chat_id",
    autonomy: "confirm",
    audited: true,
  },

  // ── Subscription (Event Manager) ──────────────────────────────────────────
  {
    id: "subscription.create",
    description: "Create an event subscription for trigger-based case activation or resumption.",
    scope: "subscription",
    args: [
      { name: "event_id",    type: "string", required: true,  description: "Event element ID." },
      { name: "process_id",  type: "string", required: true,  description: "Process definition ID." },
      { name: "instance_id", type: "string", required: true,  description: "Case ID or 'new' for auto-create." },
      { name: "trigger",     type: "object", required: true,  description: "Trigger definition (TriggerDef)." },
    ],
    currentEndpoint: "POST /api/event-manager/subscribe",
    autonomy: "auto",
    audited: true,
  },
  {
    id: "subscription.cancel",
    description: "Cancel an active event subscription.",
    scope: "subscription",
    args: [
      { name: "id", type: "string", required: true, description: "Subscription ID to cancel." },
    ],
    currentEndpoint: "DELETE /api/event-manager/subscribe/:id",
    autonomy: "auto",
    audited: true,
  },
  {
    id: "subscription.list",
    description: "List all active event subscriptions.",
    scope: "subscription",
    args: [],
    currentEndpoint: "GET /api/event-manager/subscriptions",
    autonomy: "auto",
    audited: false,
  },

  // ── Issue (GitHub) ────────────────────────────────────────────────────────
  {
    id: "issue.create",
    description: "Create a GitHub issue in the konoha repo.",
    scope: "issue",
    args: [
      { name: "title",    type: "string", required: true,  description: "Issue title." },
      { name: "body",     type: "string", required: true,  description: "Issue body (markdown)." },
      { name: "priority", type: "string", required: false, description: "Priority label: P0 | P1 | P2 | P3." },
      { name: "labels",   type: "array",  required: false, description: "Additional labels." },
    ],
    implementation: { kind: "registered-handler", note: "Registered in action-handlers.ts." },
    autonomy: "auto",
    audited: true,
  },

  // ── Reminder ──────────────────────────────────────────────────────────────
  {
    id: "reminder.create",
    description: "Create a scheduled reminder.",
    scope: "reminder",
    args: [
      { name: "type",         type: "string", required: false, description: "Reminder type, defaults to standalone." },
      { name: "recipient",    type: "string", required: true,  description: "Agent or person ID." },
      { name: "message",      type: "string", required: true,  description: "Reminder message text." },
      { name: "scheduled_at", type: "string", required: true,  description: "ISO 8601 scheduled time." },
      { name: "channel",      type: "string", required: false, description: "Delivery channel: gui | telegram." },
      { name: "case_id",      type: "string", required: false, description: "Related case ID." },
      { name: "process_id",   type: "string", required: false, description: "Related workflow/process ID." },
      { name: "element_id",   type: "string", required: false, description: "Related workflow element ID." },
      { name: "work_item_id", type: "string", required: false, description: "Related work item ID." },
    ],
    currentEndpoint: "POST /reminders",
    autonomy: "auto",
    audited: true,
  },
  {
    id: "reminder.list",
    description: "List reminders with optional filters.",
    scope: "reminder",
    args: [
      { name: "status",    type: "string", required: false, description: "Filter by status." },
      { name: "recipient", type: "string", required: false, description: "Filter by recipient." },
    ],
    currentEndpoint: "GET /reminders",
    autonomy: "auto",
    audited: false,
  },
  {
    id: "reminder.update_status",
    description: "Update reminder status (e.g. mark as sent).",
    scope: "reminder",
    args: [
      { name: "id",     type: "string", required: true, description: "Reminder ID." },
      { name: "status", type: "string", required: true, description: "New status." },
    ],
    currentEndpoint: "PATCH /reminders/:id/status",
    autonomy: "auto",
    audited: true,
  },
  {
    id: "reminder.delete",
    description: "Delete a reminder.",
    scope: "reminder",
    args: [
      { name: "id", type: "string", required: true, description: "Reminder ID." },
    ],
    currentEndpoint: "DELETE /reminders/:id",
    autonomy: "auto",
    audited: true,
  },

  // ── Message ───────────────────────────────────────────────────────────────
  {
    id: "message.send",
    description: "Send a message to an agent, role group, or broadcast.",
    scope: "message",
    args: [
      { name: "to",   type: "string", required: true,  description: "Recipient: agent ID, 'all', or 'role:<role>'." },
      { name: "text", type: "string", required: true,  description: "Message text (max 32768 chars)." },
      { name: "type", type: "string", required: false, description: "Message type: message | task | result | status | event." },
    ],
    currentEndpoint: "POST /messages",
    autonomy: "auto",
    audited: true,
  },
  {
    id: "message.read",
    description: "Read new (unacknowledged) messages for an agent.",
    scope: "message",
    args: [
      { name: "agent_id", type: "string", required: true,  description: "Agent ID to read for." },
      { name: "count",    type: "number", required: false, description: "Max messages to return." },
    ],
    currentEndpoint: "GET /messages/:agentId",
    autonomy: "auto",
    audited: false,
  },

  // ── Audit ─────────────────────────────────────────────────────────────────
  {
    id: "audit.read",
    description: "Read the action audit log with optional filters.",
    scope: "audit",
    args: [
      { name: "action_type", type: "string", required: false, description: "Filter by action type." },
      { name: "agent",       type: "string", required: false, description: "Filter by agent." },
      { name: "from_date",   type: "string", required: false, description: "Start date filter." },
      { name: "to_date",     type: "string", required: false, description: "End date filter." },
      { name: "limit",       type: "number", required: false, description: "Max entries to return." },
    ],
    currentEndpoint: "GET /audit",
    autonomy: "auto",
    audited: false,
  },

  // ── Event (manual confirmation) ───────────────────────────────────────────
  {
    id: "event.confirm",
    description: "Confirm a manual event wait, advancing the case past the current event node.",
    scope: "case",
    args: [
      { name: "case_id",      type: "string", required: true,  description: "Case ID to confirm event for." },
      { name: "element_id",   type: "string", required: false, description: "Event element ID (defaults to current position)." },
      { name: "comment",      type: "string", required: false, description: "Optional confirmation comment." },
      { name: "confirmed_by", type: "string", required: true,  description: "User ID of the confirmer." },
      { name: "outcome",      type: "string", required: false, description: "Outcome for approval gates: approved | rejected." },
    ],
    currentEndpoint: "POST /events/mining/case/:id/confirm-event",
    autonomy: "auto",
    audited: true,
  },
  {
    id: "event.wait_list",
    description: "List active manual event waits (inbox), optionally filtered by assignee.",
    scope: "case",
    args: [
      { name: "assignee", type: "string", required: false, description: "Filter by assignee role or user ID." },
      { name: "status",   type: "string", required: false, description: "Filter by wait status: active | overdue | escalated." },
    ],
    implementation: { kind: "planned", note: "Manual wait inbox action is registered but still needs direct endpoint/executor wiring." },
    autonomy: "auto",
    audited: false,
  },

  // ── Knowledge ─────────────────────────────────────────────────────────────
  {
    id: "knowledge.tree",
    description: "Get the knowledge base file tree.",
    scope: "knowledge",
    args: [],
    currentEndpoint: "GET /api/kb/tree",
    autonomy: "auto",
    audited: false,
  },
  {
    id: "knowledge.read",
    description: "Read a file from the knowledge base.",
    scope: "knowledge",
    args: [
      { name: "path", type: "string", required: true, description: "Relative file path." },
    ],
    currentEndpoint: "GET /api/kb/file",
    autonomy: "auto",
    audited: false,
  },
  {
    id: "knowledge.search",
    description: "Full-text search in knowledge base markdown files.",
    scope: "knowledge",
    args: [
      { name: "q", type: "string", required: true, description: "Search query." },
    ],
    currentEndpoint: "GET /api/kb/search",
    autonomy: "auto",
    audited: false,
  },
];

// ── Registry API ────────────────────────────────────────────────────────────

const registry = new Map<string, ActionDef>();

// Populate on load
for (const action of ACTIONS) {
  registry.set(action.id, action);
}

/** Freeze the array — callers get readonly references */
export function getAction(id: string): ActionDef | undefined {
  return registry.get(id);
}

export function listActions(scope?: ObjectScope): ActionDef[] {
  const all = [...registry.values()];
  if (!scope) return all;
  return all.filter(a => a.scope === scope);
}

export function getActionsByScope(scope: ObjectScope): ActionDef[] {
  return listActions(scope);
}

export function getScopes(): ObjectScope[] {
  const scopes = new Set<ObjectScope>();
  for (const action of registry.values()) scopes.add(action.scope);
  return [...scopes];
}

/** Validate that an action ID is known to the registry */
export function isValidAction(id: string): boolean {
  return registry.has(id);
}

/** Get the total count of registered actions */
export function getActionCount(): number {
  return registry.size;
}

function resolveImplementation(action: ActionDef): ActionImplementation {
  if (action.implementation) return action.implementation;
  if (action.currentEndpoint) return { kind: "endpoint", note: action.currentEndpoint };
  return { kind: "planned", note: "No endpoint, direct executor, or registered handler has been declared yet." };
}

export function getActionSurface(action: ActionDef): ActionSurfaceEntry {
  const implementation = resolveImplementation(action);
  return {
    ...action,
    category: classifyAction(action.id),
    implementation,
    security: getActionSecurity(action),
    implemented: implementation.kind !== "planned",
  };
}

export function listActionSurface(scope?: ObjectScope): ActionSurfaceEntry[] {
  return listActions(scope).map(getActionSurface);
}

/** Full registry dump for debugging / API exposure */
export function dumpRegistry(): { version: number; actions: ActionDef[]; surface: ActionSurfaceEntry[] } {
  const actions = [...registry.values()];
  return { version: ACTION_VERSION, actions, surface: actions.map(getActionSurface) };
}

// ── Argument Validation ──────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/** Validate that provided args match the ActionDef argument contract */
export function validateActionArgs(actionId: string, args: Record<string, unknown>): ValidationResult {
  const action = registry.get(actionId);
  if (!action) {
    return { valid: false, errors: [`Unknown action: ${actionId}`] };
  }

  const errors: string[] = [];

  for (const arg of action.args) {
    const value = args[arg.name];

    // Check required
    if (arg.required && (value === undefined || value === null)) {
      errors.push(`Missing required argument: ${arg.name}`);
      continue;
    }

    // Skip type check for missing optional args
    if (value === undefined || value === null) continue;

    // Type coercion checks
    switch (arg.type) {
      case "string":
        if (typeof value !== "string") errors.push(`Expected string for "${arg.name}", got ${typeof value}`);
        break;
      case "number":
        if (typeof value !== "number" || Number.isNaN(value)) errors.push(`Expected number for "${arg.name}", got ${typeof value}`);
        break;
      case "boolean":
        if (typeof value !== "boolean") errors.push(`Expected boolean for "${arg.name}", got ${typeof value}`);
        break;
      case "object":
        if (typeof value !== "object" || value === null || Array.isArray(value)) errors.push(`Expected object for "${arg.name}"`);
        break;
      case "array":
        if (!Array.isArray(value)) errors.push(`Expected array for "${arg.name}", got ${typeof value}`);
        break;
      case "date":
        if (typeof value !== "string" || Number.isNaN(Date.parse(value as string))) errors.push(`Expected ISO 8601 date string for "${arg.name}"`);
        break;
    }
  }

  return { valid: errors.length === 0, errors };
}

export interface ActionContract {
  def: ActionDef;
  validate: (args: Record<string, unknown>) => ValidationResult;
}

/** Get a typed action contract for use by the assistant layer */
export function getActionContract(actionId: string): ActionContract | undefined {
  const def = registry.get(actionId);
  if (!def) return undefined;
  return {
    def,
    validate: (args: Record<string, unknown>) => validateActionArgs(actionId, args),
  };
}
