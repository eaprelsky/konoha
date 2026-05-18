import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";

export type WorkloadKey =
  | "process_instances"
  | "telegram_events"
  | "telegram_activation_chains"
  | "redis_stream_messages"
  | "outbox_retry_attempts"
  | "retention_cycles"
  | "ui_compaction_case_window";

export type ThresholdKey =
  | "redis_command_rate_per_sec"
  | "redis_write_rate_per_sec"
  | "redis_memory_growth_mib"
  | "process_rss_peak_mib"
  | "cpu_sustained_percent"
  | "stream_pending_max"
  | "outbox_retry_p95_ms"
  | "ui_compacted_case_window"
  | "retention_unscanned_expired_cases";

export type WorkloadPlan = Record<WorkloadKey, number>;
export type RegressionThresholds = Record<ThresholdKey, number>;

export interface BpmsLoadProfile {
  id: string;
  budget_profile: string;
  purpose: string;
  duration_sec: number;
  workload: WorkloadPlan;
  thresholds: RegressionThresholds;
}

export interface BpmsLoadCatalog {
  schema_version: number;
  updated_for_issue: number;
  release_gate: {
    required_profiles: string[];
    required_report: string;
    attach_to: string;
  };
  profiles: BpmsLoadProfile[];
}

export interface ResourceBudgetProfile {
  memory_max_mib: number;
  cpu_quota_percent: number;
  scale_out_at?: { sustained_cpu_percent?: number };
}

export interface ResourceBudgetContract {
  schema_version: number;
  budget_profiles: Record<string, ResourceBudgetProfile>;
}

export interface BpmsLoadObservation {
  profile_id: string;
  run_id: string;
  started_at: string;
  duration_sec: number;
  workload: Partial<WorkloadPlan>;
  metrics: RegressionThresholds;
}

export interface RegressionCheck {
  name: string;
  actual: number;
  limit: number;
  status: "pass" | "fail";
  detail: string;
}

export interface BpmsRegressionReport {
  schema_version: 1;
  profile_id: string;
  run_id: string;
  status: "pass" | "fail";
  generated_at: string;
  budget_profile: string;
  duration_sec: number;
  checks: RegressionCheck[];
  release_gate_attachment: string;
}

const REQUIRED_WORKLOAD_KEYS: WorkloadKey[] = [
  "process_instances",
  "telegram_events",
  "telegram_activation_chains",
  "redis_stream_messages",
  "outbox_retry_attempts",
  "retention_cycles",
  "ui_compaction_case_window",
];

const REQUIRED_THRESHOLD_KEYS: ThresholdKey[] = [
  "redis_command_rate_per_sec",
  "redis_write_rate_per_sec",
  "redis_memory_growth_mib",
  "process_rss_peak_mib",
  "cpu_sustained_percent",
  "stream_pending_max",
  "outbox_retry_p95_ms",
  "ui_compacted_case_window",
  "retention_unscanned_expired_cases",
];

export function loadBpmsLoadCatalog(path = "docs/bpms-load-profiles.json"): BpmsLoadCatalog {
  return JSON.parse(readFileSync(resolve(path), "utf-8")) as BpmsLoadCatalog;
}

export function loadResourceBudgetContract(path = "docs/resource-budgets.json"): ResourceBudgetContract {
  return JSON.parse(readFileSync(resolve(path), "utf-8")) as ResourceBudgetContract;
}

export function loadBpmsObservation(path: string): BpmsLoadObservation {
  return JSON.parse(readFileSync(resolve(path), "utf-8")) as BpmsLoadObservation;
}

export function findBpmsLoadProfile(catalog: BpmsLoadCatalog, id: string): BpmsLoadProfile {
  const profile = catalog.profiles.find(candidate => candidate.id === id);
  if (!profile) throw new Error(`Unknown BPMS load profile: ${id}`);
  return profile;
}

export function validateBpmsLoadCatalog(
  catalog: BpmsLoadCatalog,
  budgets: ResourceBudgetContract,
): string[] {
  const errors: string[] = [];
  if (catalog.schema_version !== 1) errors.push(`Unsupported catalog schema_version=${catalog.schema_version}`);
  if (catalog.updated_for_issue !== 788) errors.push("BPMS load catalog must be tied to issue #788");
  if (!Array.isArray(catalog.profiles) || catalog.profiles.length === 0) errors.push("Catalog must define profiles");

  const seen = new Set<string>();
  for (const profile of catalog.profiles) {
    if (seen.has(profile.id)) errors.push(`Duplicate BPMS load profile id=${profile.id}`);
    seen.add(profile.id);

    const budget = budgets.budget_profiles[profile.budget_profile];
    if (!budget) {
      errors.push(`${profile.id}: unknown budget_profile=${profile.budget_profile}`);
      continue;
    }

    if (profile.duration_sec <= 0) errors.push(`${profile.id}: duration_sec must be positive`);
    for (const key of REQUIRED_WORKLOAD_KEYS) {
      if (!Number.isFinite(profile.workload[key]) || profile.workload[key] <= 0) {
        errors.push(`${profile.id}: workload.${key} must be positive`);
      }
    }
    for (const key of REQUIRED_THRESHOLD_KEYS) {
      if (!Number.isFinite(profile.thresholds[key]) || profile.thresholds[key] < 0) {
        errors.push(`${profile.id}: thresholds.${key} must be non-negative`);
      }
    }

    if (profile.thresholds.process_rss_peak_mib > budget.memory_max_mib) {
      errors.push(`${profile.id}: RSS threshold exceeds ${profile.budget_profile} memory budget`);
    }
    if (profile.thresholds.cpu_sustained_percent > budget.cpu_quota_percent) {
      errors.push(`${profile.id}: CPU threshold exceeds ${profile.budget_profile} CPU quota`);
    }
    const scaleOutCpu = budget.scale_out_at?.sustained_cpu_percent;
    if (scaleOutCpu !== undefined && profile.thresholds.cpu_sustained_percent > scaleOutCpu) {
      errors.push(`${profile.id}: CPU threshold exceeds ${profile.budget_profile} scale-out threshold`);
    }
  }

  const ids = new Set(catalog.profiles.map(profile => profile.id));
  for (const required of catalog.release_gate.required_profiles) {
    if (!ids.has(required)) errors.push(`release_gate.required_profiles references missing profile=${required}`);
  }

  const soak = catalog.profiles.find(profile => profile.id === "staging-soak-8h");
  if (!soak) {
    errors.push("Catalog must define staging-soak-8h");
  } else {
    if (soak.budget_profile !== "staging-core") errors.push("staging-soak-8h must use staging-core budget");
    if (soak.duration_sec < 8 * 60 * 60) errors.push("staging-soak-8h must run for at least eight hours");
  }

  return errors;
}

export function evaluateBpmsObservation(
  catalog: BpmsLoadCatalog,
  observation: BpmsLoadObservation,
  generatedAt = new Date().toISOString(),
): BpmsRegressionReport {
  const profile = findBpmsLoadProfile(catalog, observation.profile_id);
  const checks: RegressionCheck[] = [];

  for (const key of REQUIRED_WORKLOAD_KEYS) {
    checks.push(minCheck(`workload.${key}`, observation.workload[key] ?? 0, profile.workload[key]));
  }
  checks.push(minCheck("duration_sec", observation.duration_sec, profile.duration_sec));

  for (const key of REQUIRED_THRESHOLD_KEYS) {
    checks.push(maxCheck(`metrics.${key}`, observation.metrics[key], profile.thresholds[key]));
  }

  return {
    schema_version: 1,
    profile_id: profile.id,
    run_id: observation.run_id,
    status: checks.every(check => check.status === "pass") ? "pass" : "fail",
    generated_at: generatedAt,
    budget_profile: profile.budget_profile,
    duration_sec: observation.duration_sec,
    checks,
    release_gate_attachment: catalog.release_gate.required_report,
  };
}

export function writeBpmsRegressionReport(path: string, report: BpmsRegressionReport): void {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
}

function minCheck(name: string, actual: number, limit: number): RegressionCheck {
  return {
    name,
    actual,
    limit,
    status: actual >= limit ? "pass" : "fail",
    detail: `${name} must be >= ${limit}`,
  };
}

function maxCheck(name: string, actual: number, limit: number): RegressionCheck {
  return {
    name,
    actual,
    limit,
    status: actual <= limit ? "pass" : "fail",
    detail: `${name} must be <= ${limit}`,
  };
}
