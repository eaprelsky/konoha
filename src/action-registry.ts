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

// ── Version ─────────────────────────────────────────────────────────────────

export const ACTION_VERSION = 1;

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
  | "adapter"     // data adapter operations
  | "reminder"    // scheduled reminders
  | "issue"       // GitHub issue operations
  | "subscription"// event manager subscriptions
  | "audit"       // audit log reads
  | "knowledge"   // knowledge base operations
  | "message";    // bus messages

export type AutonomyLevel = "auto" | "confirm" | "disabled";

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
  /** Default autonomy level */
  autonomy: AutonomyLevel;
  /** Whether this action writes to the audit log */
  audited: boolean;
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
    autonomy: "auto",
    audited: true,
  },

  // ── Reminder ──────────────────────────────────────────────────────────────
  {
    id: "reminder.create",
    description: "Create a scheduled reminder.",
    scope: "reminder",
    args: [
      { name: "recipient",    type: "string", required: true,  description: "Agent or person ID." },
      { name: "message",      type: "string", required: true,  description: "Reminder message text." },
      { name: "scheduled_at", type: "string", required: true,  description: "ISO 8601 scheduled time." },
      { name: "channel",      type: "string", required: false, description: "Delivery channel: gui | telegram." },
      { name: "case_id",      type: "string", required: false, description: "Related case ID." },
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

/** Full registry dump for debugging / API exposure */
export function dumpRegistry(): { version: number; actions: ActionDef[] } {
  return { version: ACTION_VERSION, actions: [...registry.values()] };
}
