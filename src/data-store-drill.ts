import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";

export interface DataStoreDrillContract {
  schema_version: number;
  updated_for_issue: number;
  default_report: string;
  global_targets: {
    rpo_minutes: number;
    rto_minutes: number;
    staging_restore_required: boolean;
    production_restore_requires_owner_approval: boolean;
  };
  owners: Record<"primary" | "secondary" | "reviewer" | "escalation", string>;
  data_stores: DataStoreBackupTarget[];
  staging_restore_drill: {
    cadence: string;
    required_environment: string;
    steps: string[];
    verification: string[];
  };
}

export interface DataStoreBackupTarget {
  id: string;
  kind: string;
  criticality: "tier0" | "tier1" | "tier2";
  contains_secrets: boolean;
  rpo_minutes: number;
  rto_minutes: number;
  backup: {
    cadence: string;
    command: string;
    artifact: string;
    retention_days: number;
    encryption_required: boolean;
  };
  restore: {
    target: "staging" | "production";
    command: string;
  };
  verification: string[];
}

export interface DataStoreDrillObservation {
  drill_id: string;
  environment: string;
  started_at: string;
  completed_at: string;
  artifacts: Record<string, {
    age_minutes: number;
    encrypted: boolean;
    restored: boolean;
    verified: boolean;
  }>;
  rto_minutes: number;
  verification: {
    pg_verify_passed: boolean;
    redis_ping_passed: boolean;
    workflow_smoke_passed: boolean;
    shared_config_validated: boolean;
    secrets_inventory_checked: boolean;
  };
}

export interface DataStoreDrillCheck {
  name: string;
  status: "pass" | "fail";
  detail: string;
}

export interface DataStoreDrillReport {
  schema_version: 1;
  drill_id: string;
  status: "pass" | "fail";
  generated_at: string;
  environment: string;
  rpo_minutes: number;
  rto_minutes: number;
  checks: DataStoreDrillCheck[];
}

const REQUIRED_STORE_IDS = ["postgres", "redis", "workflow-runtime", "operational-config"];
const REQUIRED_OWNER_KEYS = ["primary", "secondary", "reviewer", "escalation"] as const;

export function loadDataStoreDrillContract(path = "docs/data-store-drill.json"): DataStoreDrillContract {
  return JSON.parse(readFileSync(resolve(path), "utf-8")) as DataStoreDrillContract;
}

export function loadDataStoreDrillObservation(path: string): DataStoreDrillObservation {
  return JSON.parse(readFileSync(resolve(path), "utf-8")) as DataStoreDrillObservation;
}

export function validateDataStoreDrillContract(contract: DataStoreDrillContract): string[] {
  const errors: string[] = [];
  if (contract.schema_version !== 1) errors.push(`Unsupported schema_version=${contract.schema_version}`);
  if (contract.updated_for_issue !== 787) errors.push("Data-store drill contract must be tied to issue #787");
  if (contract.default_report !== "konoha-data-store-drill-report.json") {
    errors.push("default_report must be konoha-data-store-drill-report.json");
  }
  if (contract.global_targets.rpo_minutes <= 0) errors.push("global_targets.rpo_minutes must be positive");
  if (contract.global_targets.rto_minutes <= 0) errors.push("global_targets.rto_minutes must be positive");
  if (!contract.global_targets.staging_restore_required) errors.push("staging restore drill is required");
  if (!contract.global_targets.production_restore_requires_owner_approval) {
    errors.push("production restore must require owner approval");
  }

  for (const key of REQUIRED_OWNER_KEYS) {
    if (!contract.owners[key]) errors.push(`owners.${key} is required`);
  }

  const ids = new Set(contract.data_stores.map(store => store.id));
  for (const id of REQUIRED_STORE_IDS) {
    if (!ids.has(id)) errors.push(`missing data store target: ${id}`);
  }

  for (const store of contract.data_stores) {
    if (store.rpo_minutes <= 0 || store.rpo_minutes > contract.global_targets.rpo_minutes) {
      errors.push(`${store.id}: rpo_minutes must be within global RPO`);
    }
    if (store.rto_minutes <= 0 || store.rto_minutes > contract.global_targets.rto_minutes) {
      errors.push(`${store.id}: rto_minutes must be within global RTO`);
    }
    if (!store.backup.command.trim()) errors.push(`${store.id}: backup.command is required`);
    if (!store.restore.command.trim()) errors.push(`${store.id}: restore.command is required`);
    if (store.restore.target !== "staging") errors.push(`${store.id}: restore drill target must be staging`);
    if (store.backup.retention_days < 7) errors.push(`${store.id}: backup retention must be at least 7 days`);
    if (store.contains_secrets && !store.backup.encryption_required) {
      errors.push(`${store.id}: secret-bearing backups must require encryption`);
    }
    if (store.verification.length === 0) errors.push(`${store.id}: verification commands are required`);
  }

  if (contract.staging_restore_drill.required_environment !== "staging-core") {
    errors.push("staging_restore_drill.required_environment must be staging-core");
  }
  if (contract.staging_restore_drill.steps.length < 5) {
    errors.push("staging_restore_drill must include a complete verification checklist");
  }
  if (!contract.staging_restore_drill.verification.some(command => command.includes("data-store-drill.ts --check"))) {
    errors.push("staging_restore_drill verification must include automated contract check");
  }

  return errors;
}

export function evaluateDataStoreDrill(
  contract: DataStoreDrillContract,
  observation: DataStoreDrillObservation,
  generatedAt = new Date().toISOString(),
): DataStoreDrillReport {
  const checks: DataStoreDrillCheck[] = [];

  checks.push(passIf("environment.staging", observation.environment === contract.staging_restore_drill.required_environment, `environment must be ${contract.staging_restore_drill.required_environment}`));
  checks.push(passIf("rto", observation.rto_minutes <= contract.global_targets.rto_minutes, `rto_minutes must be <= ${contract.global_targets.rto_minutes}`));

  for (const store of contract.data_stores) {
    const artifact = observation.artifacts[store.id];
    checks.push(passIf(`${store.id}.artifact_present`, artifact !== undefined, "artifact evidence is required"));
    if (!artifact) continue;
    checks.push(passIf(`${store.id}.rpo`, artifact.age_minutes <= store.rpo_minutes, `artifact age must be <= ${store.rpo_minutes} minutes`));
    checks.push(passIf(`${store.id}.encrypted`, !store.backup.encryption_required || artifact.encrypted, "encrypted backup artifact is required"));
    checks.push(passIf(`${store.id}.restored`, artifact.restored, "artifact must be restored into staging"));
    checks.push(passIf(`${store.id}.verified`, artifact.verified, "artifact verification must pass"));
  }

  for (const [name, value] of Object.entries(observation.verification)) {
    checks.push(passIf(`verification.${name}`, value === true, `${name} must pass`));
  }

  return {
    schema_version: 1,
    drill_id: observation.drill_id,
    status: checks.every(check => check.status === "pass") ? "pass" : "fail",
    generated_at: generatedAt,
    environment: observation.environment,
    rpo_minutes: contract.global_targets.rpo_minutes,
    rto_minutes: observation.rto_minutes,
    checks,
  };
}

export function writeDataStoreDrillReport(path: string, report: DataStoreDrillReport): void {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
}

function passIf(name: string, condition: boolean, detail: string): DataStoreDrillCheck {
  return { name, status: condition ? "pass" : "fail", detail };
}
