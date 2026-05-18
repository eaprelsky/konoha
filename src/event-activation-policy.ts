import { createHash } from "crypto";
import { redis } from "./redis";

export const ACTIVATION_SUPPRESSIONS_STREAM = "konoha:workflow:event-activation:suppressed";
export const ACTIVATION_SUPPRESSION_MAXLEN = 2000;

export type ActivationReasonCode =
  | "ACCEPTED"
  | "ACTIVATION_DISABLED"
  | "LOW_CONFIDENCE"
  | "DUPLICATE"
  | "RATE_LIMITED"
  | "BACKPRESSURE"
  | "SAMPLED_OUT"
  | "UNMATCHED_TRIGGER";

export interface ActivationRateLimitPolicy {
  window_sec: number;
  max_events: number;
  scope?: Array<"workflow" | "connector" | "endpoint" | "chat" | "source">;
}

export interface ActivationBackpressurePolicy {
  max_running_cases?: number;
}

export interface ActivationSamplingPolicy {
  rate: number;
  key_fields?: string[];
}

export interface WorkflowActivationPolicy {
  enabled?: boolean;
  min_confidence?: number;
  confidence_field?: string;
  dedup_window_sec?: number;
  dedup_fields?: string[];
  rate_limit?: ActivationRateLimitPolicy;
  backpressure?: ActivationBackpressurePolicy;
  sampling?: ActivationSamplingPolicy;
  inspect_suppressed?: boolean;
}

export interface ActivationDecision {
  accepted: boolean;
  reason_code: ActivationReasonCode;
  action: "accept" | "suppress" | "throttle" | "reject";
  inspectable: boolean;
  detail: Record<string, unknown>;
}

export interface ActivationEvaluationInput {
  workflow_id: string;
  event_type: string;
  source: string;
  payload: Record<string, unknown>;
  policy?: WorkflowActivationPolicy;
}

const DEFAULT_DEDUP_FIELDS = ["connector_id", "endpoint_id", "chat_ref", "chat_id", "message_id", "msg_id"];
const DEFAULT_RATE_SCOPE: Required<ActivationRateLimitPolicy>["scope"] = ["workflow", "connector", "chat"];

export function stableActivationDigest(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function valueAtPath(payload: Record<string, unknown>, path: string): unknown {
  if (!path.includes(".")) return payload[path];
  let current: unknown = payload;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function stringValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const out = String(value).trim();
  return out || undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function positiveInt(value: unknown): number | undefined {
  const parsed = numberValue(value);
  if (parsed === undefined) return undefined;
  const int = Math.floor(parsed);
  return int > 0 ? int : undefined;
}

function confidenceFromPayload(payload: Record<string, unknown>, policy: WorkflowActivationPolicy): number | undefined {
  const field = policy.confidence_field || "confidence";
  return numberValue(valueAtPath(payload, field)) ?? numberValue(payload.router_confidence);
}

function policyDedupKey(input: ActivationEvaluationInput, policy: WorkflowActivationPolicy): string | undefined {
  const payloadKey = stringValue(input.payload.idempotency_key);
  if (payloadKey) return payloadKey;

  const fields = policy.dedup_fields?.length ? policy.dedup_fields : DEFAULT_DEDUP_FIELDS;
  const values = fields.map(field => stringValue(valueAtPath(input.payload, field)) ?? "");
  if (values.every(value => value === "")) return undefined;
  return stableActivationDigest([input.workflow_id, input.event_type, input.source, ...values]);
}

function scopePart(name: string, input: ActivationEvaluationInput): string {
  if (name === "workflow") return input.workflow_id;
  if (name === "source") return input.source;
  if (name === "connector") return stringValue(input.payload.connector_id) ?? input.source;
  if (name === "endpoint") return stringValue(input.payload.endpoint_id) ?? "*";
  if (name === "chat") {
    return stringValue(input.payload.chat_ref) ?? stringValue(input.payload.chat_id) ?? "*";
  }
  return "*";
}

async function runningCasesForWorkflow(workflowId: string, maxNeeded: number): Promise<number> {
  const caseIds = await redis.smembers(`konoha:cases:process:${workflowId}`).catch(() => [] as string[]);
  let running = 0;
  for (const caseId of caseIds) {
    const raw = await redis.get(`case:${caseId}`).catch(() => null);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as { status?: string };
      if (parsed.status === "running") {
        running += 1;
        if (running >= maxNeeded) return running;
      }
    } catch {
      continue;
    }
  }
  return running;
}

function samplingAccepted(input: ActivationEvaluationInput, policy: ActivationSamplingPolicy): boolean {
  if (policy.rate >= 1) return true;
  if (policy.rate <= 0) return false;
  const fields = policy.key_fields?.length ? policy.key_fields : DEFAULT_DEDUP_FIELDS;
  const seed = fields.map(field => stringValue(valueAtPath(input.payload, field)) ?? "").join("|")
    || JSON.stringify([input.workflow_id, input.event_type, input.source, input.payload]);
  const bucket = parseInt(stableActivationDigest([input.workflow_id, seed]).slice(0, 8), 16) / 0xffffffff;
  return bucket < policy.rate;
}

function decision(
  accepted: boolean,
  reason_code: ActivationReasonCode,
  action: ActivationDecision["action"],
  policy: WorkflowActivationPolicy | undefined,
  detail: Record<string, unknown> = {},
): ActivationDecision {
  return {
    accepted,
    reason_code,
    action,
    inspectable: !accepted && policy?.inspect_suppressed !== false,
    detail,
  };
}

export async function evaluateActivationPolicy(input: ActivationEvaluationInput): Promise<ActivationDecision> {
  const policy = input.policy;
  if (!policy) return decision(true, "ACCEPTED", "accept", policy);
  if (policy.enabled === false) return decision(false, "ACTIVATION_DISABLED", "reject", policy);

  const minConfidence = numberValue(policy.min_confidence);
  if (minConfidence !== undefined) {
    const confidence = confidenceFromPayload(input.payload, policy);
    if (confidence !== undefined && confidence < minConfidence) {
      return decision(false, "LOW_CONFIDENCE", "suppress", policy, { confidence, min_confidence: minConfidence });
    }
  }

  if (policy.dedup_window_sec) {
    const windowSec = positiveInt(policy.dedup_window_sec);
    const dedupKey = policyDedupKey(input, policy);
    if (windowSec && dedupKey) {
      const redisKey = `konoha:activation:dedup:${stableActivationDigest([input.workflow_id, dedupKey])}`;
      const claimed = await redis.set(redisKey, "1", "EX", windowSec, "NX");
      if (claimed !== "OK") {
        return decision(false, "DUPLICATE", "suppress", policy, { dedup_key: dedupKey, window_sec: windowSec });
      }
    }
  }

  if (policy.rate_limit) {
    const windowSec = positiveInt(policy.rate_limit.window_sec);
    const maxEvents = positiveInt(policy.rate_limit.max_events);
    if (windowSec && maxEvents) {
      const scope = policy.rate_limit.scope?.length ? policy.rate_limit.scope : DEFAULT_RATE_SCOPE;
      const scopeValues = scope.map(part => `${part}:${scopePart(part, input)}`);
      const bucket = Math.floor(Date.now() / (windowSec * 1000));
      const key = `konoha:activation:rate:${stableActivationDigest([input.event_type, ...scopeValues, bucket])}`;
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, windowSec * 2);
      if (count > maxEvents) {
        return decision(false, "RATE_LIMITED", "throttle", policy, {
          count,
          max_events: maxEvents,
          window_sec: windowSec,
          scope: scopeValues,
        });
      }
    }
  }

  if (policy.backpressure?.max_running_cases) {
    const maxRunning = positiveInt(policy.backpressure.max_running_cases);
    if (maxRunning) {
      const running = await runningCasesForWorkflow(input.workflow_id, maxRunning);
      if (running >= maxRunning) {
        return decision(false, "BACKPRESSURE", "throttle", policy, {
          running_cases: running,
          max_running_cases: maxRunning,
        });
      }
    }
  }

  if (policy.sampling && !samplingAccepted(input, policy.sampling)) {
    return decision(false, "SAMPLED_OUT", "suppress", policy, { sample_rate: policy.sampling.rate });
  }

  return decision(true, "ACCEPTED", "accept", policy);
}

export async function recordActivationSuppression(input: ActivationEvaluationInput, decision: ActivationDecision): Promise<void> {
  if (decision.accepted || !decision.inspectable) return;
  await redis.xadd(
    ACTIVATION_SUPPRESSIONS_STREAM,
    "MAXLEN",
    "~",
    ACTIVATION_SUPPRESSION_MAXLEN,
    "*",
    "workflow_id",
    input.workflow_id,
    "event_type",
    input.event_type,
    "source",
    input.source,
    "reason_code",
    decision.reason_code,
    "action",
    decision.action,
    "detail",
    JSON.stringify(decision.detail),
    "payload",
    JSON.stringify(input.payload).slice(0, 4000),
    "timestamp",
    new Date().toISOString(),
  );
}
