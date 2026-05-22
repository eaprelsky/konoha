import { createHash } from "crypto";
import { listCases } from "./runtime/cases";
import type { Case } from "./runtime/cases/types";
import {
  listRuntimeEffectsByStatus,
  type RuntimeEffectRecord,
} from "./runtime-effect-outbox";

export type OperationalAlertKind = "stuck_case" | "runtime_effect_failed";
export type OperationalAlertSeverity = "warning" | "critical";

export interface OperationalAlert {
  schema_version: 1;
  alert_id: string;
  dedupe_key: string;
  idempotency_key: string;
  kind: OperationalAlertKind;
  severity: OperationalAlertSeverity;
  title: string;
  message: string;
  generated_at: string;
  correlation: {
    case_id?: string;
    workflow_id?: string;
    process_id?: string;
    work_item_id?: string;
    effect_id?: string;
    effect_status?: string;
    effect_kind?: string;
  };
  evidence: Record<string, unknown>;
  action: {
    label: string;
    api_path: string;
    action_type?: string;
    recovery_paths?: string[];
  };
}

export interface OperationalAlertOptions {
  now?: string;
  stuck_case_warning_ms?: number;
  stuck_case_critical_ms?: number;
  limit?: number;
}

export interface OperationalAlertsReceipt {
  ok: true;
  schema_version: 1;
  generated_at: string;
  thresholds: {
    stuck_case_warning_ms: number;
    stuck_case_critical_ms: number;
  };
  summary: {
    total: number;
    warning: number;
    critical: number;
    stuck_case: number;
    runtime_effect_failed: number;
  };
  alerts: OperationalAlert[];
}

const DEFAULT_STUCK_CASE_WARNING_MS = 4 * 60 * 60 * 1000;
const DEFAULT_STUCK_CASE_CRITICAL_MS = 24 * 60 * 60 * 1000;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function finitePositive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback;
}

function alertId(dedupeKey: string): string {
  return `opalert_${digest(dedupeKey)}`;
}

function caseAgeMs(kase: Case, nowMs: number): number {
  const createdAt = Date.parse(kase.created_at);
  if (!Number.isFinite(createdAt)) return 0;
  return Math.max(0, nowMs - createdAt);
}

function stuckCaseAlert(kase: Case, ageMs: number, severity: OperationalAlertSeverity, generatedAt: string): OperationalAlert {
  const dedupeKey = `stuck_case:${kase.case_id}`;
  return {
    schema_version: 1,
    alert_id: alertId(dedupeKey),
    dedupe_key: dedupeKey,
    idempotency_key: dedupeKey,
    kind: "stuck_case",
    severity,
    title: `Stuck running case ${kase.case_id}`,
    message: `Case has been running for ${ageMs}ms at position ${kase.position || "unknown"}`,
    generated_at: generatedAt,
    correlation: {
      case_id: kase.case_id,
      workflow_id: kase.process_id,
      process_id: kase.process_id,
    },
    evidence: {
      case_id: kase.case_id,
      process_id: kase.process_id,
      status: kase.status,
      position: kase.position,
      subject: kase.subject,
      created_at: kase.created_at,
      age_ms: ageMs,
      active_branches: kase.active_branches?.length ?? 0,
      history_length: kase.history?.length ?? 0,
    },
    action: {
      label: "Inspect case and decide cancel/close recovery",
      api_path: `/cases/${encodeURIComponent(kase.case_id)}`,
      action_type: "case.get",
      recovery_paths: [
        `POST /act case.cancel id=${kase.case_id}`,
        `POST /act case.close id=${kase.case_id}`,
      ],
    },
  };
}

function runtimeEffectAlert(effect: RuntimeEffectRecord, generatedAt: string): OperationalAlert {
  const severity: OperationalAlertSeverity = effect.status === "dead_letter" ? "critical" : "warning";
  const dedupeKey = `runtime_effect_failed:${effect.effect_id}:${effect.status}`;
  return {
    schema_version: 1,
    alert_id: alertId(dedupeKey),
    dedupe_key: dedupeKey,
    idempotency_key: dedupeKey,
    kind: "runtime_effect_failed",
    severity,
    title: `Runtime effect ${effect.status}: ${effect.effect_id}`,
    message: `${effect.kind} is ${effect.status}${effect.error?.code ? ` (${effect.error.code})` : ""}`,
    generated_at: generatedAt,
    correlation: {
      case_id: effect.links.case_id,
      workflow_id: effect.links.workflow_id,
      process_id: effect.links.workflow_id,
      work_item_id: effect.links.work_item_id,
      effect_id: effect.effect_id,
      effect_status: effect.status,
      effect_kind: effect.kind,
    },
    evidence: {
      effect_id: effect.effect_id,
      kind: effect.kind,
      status: effect.status,
      attempts: effect.attempts,
      updated_at: effect.updated_at,
      completed_at: effect.completed_at,
      next_retry_at: effect.next_retry_at,
      error_code: effect.error?.code,
      error_message: effect.error?.message,
      retryable: effect.error?.retryable,
      links: effect.links,
    },
    action: {
      label: "Inspect runtime effect and choose retry/cancel/dead-letter recovery",
      api_path: `/runtime-effects/${encodeURIComponent(effect.effect_id)}`,
      recovery_paths: [
        `POST /runtime-effects/${effect.effect_id}/retry`,
        `POST /runtime-effects/${effect.effect_id}/cancel`,
        `POST /runtime-effects/${effect.effect_id}/dead-letter`,
      ],
    },
  };
}

function summarize(alerts: OperationalAlert[]): OperationalAlertsReceipt["summary"] {
  return {
    total: alerts.length,
    warning: alerts.filter(alert => alert.severity === "warning").length,
    critical: alerts.filter(alert => alert.severity === "critical").length,
    stuck_case: alerts.filter(alert => alert.kind === "stuck_case").length,
    runtime_effect_failed: alerts.filter(alert => alert.kind === "runtime_effect_failed").length,
  };
}

export async function listOperationalAlerts(options: OperationalAlertOptions = {}): Promise<OperationalAlertsReceipt> {
  const generatedAt = options.now ?? new Date().toISOString();
  const nowMs = Date.parse(generatedAt);
  if (!Number.isFinite(nowMs)) throw new Error("now must be an ISO timestamp");
  const warningMs = finitePositive(options.stuck_case_warning_ms, DEFAULT_STUCK_CASE_WARNING_MS);
  const criticalMs = finitePositive(options.stuck_case_critical_ms, DEFAULT_STUCK_CASE_CRITICAL_MS);
  const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 100)));

  const [{ cases }, failedEffects, deadLetterEffects] = await Promise.all([
    listCases({ status: "running", limit: 2000 }),
    listRuntimeEffectsByStatus("failed", { limit: 200 }),
    listRuntimeEffectsByStatus("dead_letter", { limit: 200 }),
  ]);

  const stuckCaseAlerts = cases
    .map(kase => ({ kase, ageMs: caseAgeMs(kase, nowMs) }))
    .filter(({ ageMs }) => ageMs >= warningMs)
    .map(({ kase, ageMs }) => stuckCaseAlert(kase, ageMs, ageMs >= criticalMs ? "critical" : "warning", generatedAt));

  const effectAlerts = [...failedEffects, ...deadLetterEffects]
    .map(effect => runtimeEffectAlert(effect, generatedAt));

  const byDedupe = new Map<string, OperationalAlert>();
  for (const alert of [...stuckCaseAlerts, ...effectAlerts]) {
    if (!byDedupe.has(alert.dedupe_key)) byDedupe.set(alert.dedupe_key, alert);
  }

  const alerts = [...byDedupe.values()]
    .sort((a, b) => {
      const severityRank = (b.severity === "critical" ? 1 : 0) - (a.severity === "critical" ? 1 : 0);
      if (severityRank !== 0) return severityRank;
      return a.dedupe_key.localeCompare(b.dedupe_key);
    })
    .slice(0, limit);

  return {
    ok: true,
    schema_version: 1,
    generated_at: generatedAt,
    thresholds: {
      stuck_case_warning_ms: warningMs,
      stuck_case_critical_ms: criticalMs,
    },
    summary: summarize(alerts),
    alerts,
  };
}
