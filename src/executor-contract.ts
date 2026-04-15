/**
 * executor-contract.ts — Formal role and executor contract (#501)
 *
 * Extends the basic RoleDef with:
 *   - Allowed executor types (agent, person, system)
 *   - Fallback chain (what happens when primary is unavailable)
 *   - SLA/timeout/escalation hooks
 *   - Executor resolution rules
 *
 * Built on top of the unified action registry (#499) and act envelope (#500).
 */

import type { AssignmentStrategy } from "./runtime/roles";

// ── Executor types ───────────────────────────────────────────────────────────

export type ExecutorType = "agent" | "person" | "system";

export interface ExecutorConstraint {
  /** What kind of executor is allowed */
  type: ExecutorType;
  /** Required capabilities (for agent type) */
  required_capabilities?: string[];
  /** Required MCP servers that must be available (for agent type) */
  required_mcp_servers?: string[];
  /** Minimum trust level needed (for person type): 1 = trusted, 2 = owner */
  min_trust_level?: number;
}

// ── SLA configuration ────────────────────────────────────────────────────────

export interface SLAConfig {
  /** Maximum time a work item can sit in 'pending' before escalation (ISO 8601 duration) */
  pending_timeout?: string;     // e.g. "PT2H" = 2 hours
  /** Maximum time a work item can be in 'running' before escalation */
  running_timeout?: string;     // e.g. "PT24H" = 24 hours
  /** Maximum time before a reminder is sent to the assignee */
  reminder_after?: string;      // e.g. "PT30M" = 30 minutes
  /** Who to notify on timeout */
  escalate_to?: string;         // role_id or agent_id
  /** Action to take on timeout: reassign, notify, cancel */
  escalation_action?: "reassign" | "notify" | "cancel";
  /** Whether to auto-cancel after escalation */
  auto_cancel_after?: string;   // e.g. "PT1H"
}

// ── Fallback configuration ───────────────────────────────────────────────────

export interface FallbackConfig {
  /** Ordered list of fallback executor targets */
  chain: FallbackTarget[];
  /** How many times to try fallbacks before giving up */
  max_attempts?: number;       // default: 3
  /** Delay between fallback attempts (ISO 8601 duration) */
  retry_delay?: string;        // e.g. "PT5M"
}

export interface FallbackTarget {
  /** Executor type for this fallback */
  type: ExecutorType;
  /** Target identifier: agent_id, person_id, or role_id */
  target: string;
  /** Whether this fallback should be tried only if previous failed */
  conditional?: boolean;
}

// ── Full role contract ───────────────────────────────────────────────────────

export interface RoleContract {
  /** Unique role identifier */
  role_id: string;

  /** Human-readable name */
  name: string;

  /** Description of the role's responsibility */
  description?: string;

  /** Allowed executor types for this role */
  allowed_executors: ExecutorConstraint[];

  /** Current assignees (ordered by priority) */
  assignees: string[];

  /** Assignment strategy for multi-assignee roles */
  strategy: AssignmentStrategy;

  /** Required capabilities to fulfill this role */
  required_capabilities?: string[];

  /** Fallback chain when primary assignees are unavailable */
  fallback?: FallbackConfig;

  /** SLA and timeout configuration */
  sla?: SLAConfig;

  /** Metadata */
  created_at: string;
  updated_at: string;
}

// ── Executor resolution result ───────────────────────────────────────────────

export type ExecutorResolution =
  | { type: "agent"; id: string; name: string; capabilities?: string[] }
  | { type: "person"; id: string; name: string; tg_id?: number }
  | { type: "system"; handler: string }
  | { type: "broadcast"; agents: Array<{ id: string; name: string }> }
  | { type: "fallback"; target: FallbackTarget; attempt: number }
  | { type: "unassigned"; reason: string };

// ── SLA timer events ─────────────────────────────────────────────────────────

export interface SLAEvent {
  type: "pending_timeout" | "running_timeout" | "reminder" | "escalation" | "auto_cancel";
  role_id: string;
  work_item_id: string;
  case_id?: string;
  fired_at: string;
  action_taken: string;
}

// ── Default SLA ──────────────────────────────────────────────────────────────

export const DEFAULT_SLA: SLAConfig = {
  pending_timeout: "PT2H",
  running_timeout: "PT24H",
  reminder_after: "PT30M",
  escalation_action: "notify",
};

// ── Validation ───────────────────────────────────────────────────────────────

export function validateContract(contract: RoleContract): string[] {
  const errors: string[] = [];

  if (!contract.role_id) errors.push("role_id is required");
  if (!contract.name) errors.push("name is required");

  if (contract.allowed_executors.length === 0) {
    errors.push("at least one allowed executor type must be specified");
  }

  if (contract.fallback) {
    if (contract.fallback.chain.length === 0) {
      errors.push("fallback.chain must have at least one target");
    }
    for (const target of contract.fallback.chain) {
      if (!target.type || !target.target) {
        errors.push("each fallback target must have type and target");
      }
    }
  }

  if (contract.sla) {
    if (contract.sla.escalation_action === "reassign" && !contract.sla.escalate_to) {
      errors.push("escalate_to is required when escalation_action is 'reassign'");
    }
  }

  return errors;
}

// ── Contract to RoleDef conversion ───────────────────────────────────────────

/**
 * Convert a full RoleContract to the legacy RoleDef format
 * for compatibility with the existing runtime.
 */
export function contractToLegacyRole(contract: RoleContract): {
  role_id: string;
  name: string;
  description?: string;
  assignees: string[];
  strategy: AssignmentStrategy;
  required_capabilities?: string[];
  created_at: string;
  updated_at: string;
  // Extended fields (stored in Redis JSON, ignored by legacy code)
  _contract_version: number;
  _allowed_executors: ExecutorConstraint[];
  _fallback?: FallbackConfig;
  _sla?: SLAConfig;
} {
  return {
    role_id: contract.role_id,
    name: contract.name,
    description: contract.description,
    assignees: contract.assignees,
    strategy: contract.strategy,
    required_capabilities: contract.required_capabilities,
    created_at: contract.created_at,
    updated_at: contract.updated_at,
    // Extended fields prefixed with _ for forward compatibility
    _contract_version: 1,
    _allowed_executors: contract.allowed_executors,
    _fallback: contract.fallback,
    _sla: contract.sla,
  };
}

/**
 * Parse a legacy RoleDef into a RoleContract.
 * Gracefully handles missing extended fields.
 */
export function legacyRoleToContract(legacy: {
  role_id: string;
  name: string;
  description?: string;
  assignees: string[];
  strategy: AssignmentStrategy;
  required_capabilities?: string[];
  created_at: string;
  updated_at: string;
  _allowed_executors?: ExecutorConstraint[];
  _fallback?: FallbackConfig;
  _sla?: SLAConfig;
}): RoleContract {
  return {
    role_id: legacy.role_id,
    name: legacy.name,
    description: legacy.description,
    assignees: legacy.assignees,
    strategy: legacy.strategy,
    required_capabilities: legacy.required_capabilities,
    allowed_executors: legacy._allowed_executors ?? inferExecutorsFromStrategy(legacy.strategy),
    fallback: legacy._fallback,
    sla: legacy._sla,
    created_at: legacy.created_at,
    updated_at: legacy.updated_at,
  };
}

/**
 * Infer default executor constraints from the role's assignment strategy.
 */
function inferExecutorsFromStrategy(strategy: AssignmentStrategy): ExecutorConstraint[] {
  switch (strategy) {
    case "round-robin":
    case "load-balancing":
      return [{ type: "agent" }];
    case "broadcast":
      return [{ type: "agent" }, { type: "person" }];
    case "manual":
    default:
      return [{ type: "agent" }, { type: "person" }, { type: "system" }];
  }
}

// ── Documentation helper ─────────────────────────────────────────────────────

export function describeContract(contract: RoleContract): string {
  const lines: string[] = [
    `Role: ${contract.name} (${contract.role_id})`,
    `Strategy: ${contract.strategy}`,
    `Executors: ${contract.allowed_executors.map(e => e.type).join(", ")}`,
    `Assignees: ${contract.assignees.join(", ") || "(none — manual)"}`,
  ];
  if (contract.fallback) {
    lines.push(`Fallback chain: ${contract.fallback.chain.map(f => `${f.type}:${f.target}`).join(" → ")}`);
  }
  if (contract.sla) {
    lines.push(`SLA: pending ${contract.sla.pending_timeout ?? "none"}, running ${contract.sla.running_timeout ?? "none"}`);
  }
  return lines.join("\n");
}
