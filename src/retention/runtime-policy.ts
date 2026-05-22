import { readFileSync } from "fs";
import { resolve } from "path";

export type RuntimeRetentionEntity =
  | "case"
  | "event"
  | "work_item"
  | "runtime_effect"
  | "event_wait"
  | "reminder"
  | "message"
  | "deploy_record"
  | "timeline_event";

export type RuntimeRetentionState = "active" | "completed" | "archived" | "compacted";

export interface RuntimeRetentionClassPolicy {
  id: string;
  entity: RuntimeRetentionEntity;
  volume: "all" | "high";
  states: RuntimeRetentionState[];
  redis_primary: boolean;
  postgres_shadow: boolean;
  archive_after_hours: number | null;
  compact_after_hours: number | null;
  delete_after_days: number | null;
  ui_visibility: string;
  audit_access: string;
  cleanup_disposition: string;
}

export interface RuntimeRetentionPolicyContract {
  schema_version: 1;
  updated_for_issue: number;
  policy_id: string;
  source_of_truth: {
    active_runtime: string;
    historical_shadow: string;
    pg_read_cutover: string;
  };
  defaults: {
    active_states: RuntimeRetentionState[];
    terminal_states: RuntimeRetentionState[];
    completed_archive_after_hours: number;
    completed_compact_after_hours: number;
    audit_delete_after_days: number;
    max_cleanup_batch: number;
    ui_default_filter: {
      hide_states: RuntimeRetentionState[];
      hide_terminal_older_than_hours: number;
      default_page_size: number;
      audit_query_can_include_states: RuntimeRetentionState[];
      audit_export_requires_role: string;
    };
  };
  safety_gates: Record<string, boolean>;
  retention_classes: RuntimeRetentionClassPolicy[];
  workflow_activation_policies: Array<{
    workflow_category: string;
    profile: string;
    default_runtime_retention_class: string;
    requires_explicit_activation: boolean;
    activation_fields: string[];
    dedupe_key: string[];
    budgets: Record<string, number>;
    backpressure: {
      on_budget_exceeded: string;
      monitor_signal: string;
    };
  }>;
  ui_compaction: Record<string, unknown>;
  pg_read_and_retention_tooling: Record<string, unknown>;
  runbook: Record<string, string>;
}

export interface RuntimeArtifactRetentionInput {
  entity: RuntimeRetentionEntity;
  state: RuntimeRetentionState;
  age_hours: number;
  volume?: "standard" | "high";
  active_work_items?: number;
  active_waits?: number;
  pending_effects?: number;
  pg_shadow_consistent?: boolean;
  redis_only_rows?: number;
}

export interface RuntimeArtifactRetentionDecision {
  retention_class: string;
  archive_eligible: boolean;
  compact_eligible: boolean;
  visible_by_default: boolean;
  blocked: boolean;
  reasons: string[];
}

export const REQUIRED_RUNTIME_RETENTION_ENTITIES: RuntimeRetentionEntity[] = [
  "case",
  "event",
  "work_item",
  "runtime_effect",
  "event_wait",
  "reminder",
  "message",
  "deploy_record",
  "timeline_event",
];

const REQUIRED_SAFETY_GATES = [
  "require_dry_run_preview",
  "require_operator_confirmation",
  "require_no_active_work_items",
  "require_no_active_waits",
  "require_no_pending_or_retry_effects",
  "require_pg_shadow_consistent",
  "block_when_redis_only_rows",
  "require_archive_before_delete",
  "redis_primary_until_pg_read_entity_safe",
];

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function positiveOrNull(value: number | null, field: string, errors: string[]): void {
  if (value === null) return;
  if (!Number.isFinite(value) || value <= 0) errors.push(`${field} must be positive or null`);
}

export function loadRuntimeRetentionPolicy(path = "docs/runtime-retention-policy.json"): RuntimeRetentionPolicyContract {
  return JSON.parse(readFileSync(resolve(path), "utf-8")) as RuntimeRetentionPolicyContract;
}

export function validateRuntimeRetentionPolicyContract(policy: RuntimeRetentionPolicyContract): string[] {
  const errors: string[] = [];
  if (policy.schema_version !== 1) errors.push(`Unsupported runtime retention schema_version=${policy.schema_version}`);
  if (policy.updated_for_issue !== 754) errors.push("Runtime retention policy must be tied to issue #754");
  if (policy.source_of_truth?.active_runtime !== "redis-primary") errors.push("active runtime source of truth must remain redis-primary");
  if (!policy.source_of_truth?.historical_shadow?.includes("postgres")) errors.push("historical shadow must identify PostgreSQL");

  const classes = Array.isArray(policy.retention_classes) ? policy.retention_classes : [];
  const seen = new Set<string>();
  const covered = new Set<RuntimeRetentionEntity>();
  for (const item of classes) {
    if (seen.has(item.id)) errors.push(`Duplicate retention class id=${item.id}`);
    seen.add(item.id);
    covered.add(item.entity);
    if (!REQUIRED_RUNTIME_RETENTION_ENTITIES.includes(item.entity)) errors.push(`${item.id}: unsupported entity=${item.entity}`);
    if (!item.redis_primary) errors.push(`${item.id}: redis_primary must stay true before PG_READ cutover`);
    if (!item.postgres_shadow) errors.push(`${item.id}: postgres_shadow must be true for audit/readiness reports`);
    if (!Array.isArray(item.states) || item.states.length === 0) errors.push(`${item.id}: states must be non-empty`);
    positiveOrNull(item.archive_after_hours, `${item.id}.archive_after_hours`, errors);
    positiveOrNull(item.compact_after_hours, `${item.id}.compact_after_hours`, errors);
    positiveOrNull(item.delete_after_days, `${item.id}.delete_after_days`, errors);
    if (!item.audit_access) errors.push(`${item.id}: audit_access is required`);
    if (!item.cleanup_disposition) errors.push(`${item.id}: cleanup_disposition is required`);
  }

  for (const entity of REQUIRED_RUNTIME_RETENTION_ENTITIES) {
    if (!covered.has(entity)) errors.push(`Missing retention class for entity=${entity}`);
  }

  const hideStates = policy.defaults?.ui_default_filter?.hide_states ?? [];
  for (const state of ["archived", "compacted"] as const) {
    if (!hideStates.includes(state)) errors.push(`UI defaults must hide ${state} runtime artifacts`);
    if (!policy.defaults?.ui_default_filter?.audit_query_can_include_states?.includes(state)) {
      errors.push(`Audit query must be able to include ${state} runtime artifacts`);
    }
  }

  for (const gate of REQUIRED_SAFETY_GATES) {
    if (policy.safety_gates?.[gate] !== true) errors.push(`Missing required safety gate ${gate}=true`);
  }

  const messenger = policy.workflow_activation_policies?.find(item => item.profile === "high_volume_messenger");
  if (!messenger) {
    errors.push("Missing high_volume_messenger activation policy");
  } else {
    if (!messenger.requires_explicit_activation) errors.push("high_volume_messenger must require explicit activation");
    if (!messenger.dedupe_key.includes("message_id")) errors.push("high_volume_messenger must dedupe by message_id");
    for (const [key, value] of Object.entries(messenger.budgets)) {
      if (!Number.isFinite(value) || value <= 0) errors.push(`high_volume_messenger budget ${key} must be positive`);
    }
  }

  if (!isObject(policy.pg_read_and_retention_tooling)) errors.push("pg_read_and_retention_tooling is required");
  if (!isObject(policy.ui_compaction)) errors.push("ui_compaction is required");
  return errors;
}

function selectRetentionClass(
  policy: RuntimeRetentionPolicyContract,
  input: RuntimeArtifactRetentionInput,
): RuntimeRetentionClassPolicy | null {
  const candidates = policy.retention_classes.filter(item => item.entity === input.entity);
  const high = input.volume === "high" ? candidates.find(item => item.volume === "high") : undefined;
  return high ?? candidates.find(item => item.volume === "all") ?? candidates[0] ?? null;
}

export function evaluateRuntimeArtifactRetention(
  policy: RuntimeRetentionPolicyContract,
  input: RuntimeArtifactRetentionInput,
): RuntimeArtifactRetentionDecision {
  const retentionClass = selectRetentionClass(policy, input);
  if (!retentionClass) {
    return {
      retention_class: "unknown",
      archive_eligible: false,
      compact_eligible: false,
      visible_by_default: true,
      blocked: true,
      reasons: [`No retention class for entity=${input.entity}`],
    };
  }

  const reasons: string[] = [];
  const active = input.state === "active";
  if (active) reasons.push("active runtime artifacts are never archived or compacted");
  if ((input.active_work_items ?? 0) > 0) reasons.push("active work items block archive/compaction");
  if ((input.active_waits ?? 0) > 0) reasons.push("active waits block archive/compaction");
  if ((input.pending_effects ?? 0) > 0) reasons.push("pending or retry runtime effects block archive/compaction");
  if (input.pg_shadow_consistent === false) reasons.push("PostgreSQL shadow consistency is required");
  if ((input.redis_only_rows ?? 0) > 0) reasons.push("Redis-only rows block cleanup and archival decisions");

  const blocked = reasons.some(reason => !reason.startsWith("active runtime"));
  const canTransition = !active && !blocked;
  const archive_eligible = canTransition
    && retentionClass.archive_after_hours !== null
    && input.age_hours >= retentionClass.archive_after_hours;
  const compact_eligible = canTransition
    && retentionClass.compact_after_hours !== null
    && input.age_hours >= retentionClass.compact_after_hours;
  const hiddenStates = new Set(policy.defaults.ui_default_filter.hide_states);
  const visible_by_default = !hiddenStates.has(input.state);

  return {
    retention_class: retentionClass.id,
    archive_eligible,
    compact_eligible,
    visible_by_default,
    blocked,
    reasons,
  };
}
