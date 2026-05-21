import { createHash } from "crypto";

export const RUNTIME_EFFECT_OUTBOX_SCHEMA_VERSION = 1;

export const RUNTIME_EFFECT_KEY_PREFIX = "runtime:effect:";
export const RUNTIME_EFFECT_IDEMPOTENCY_KEY_PREFIX = "runtime:effect:idempotency:";
export const RUNTIME_EFFECT_STATUS_INDEX_PREFIX = "runtime:effect:index:status:";
export const RUNTIME_EFFECT_CASE_INDEX_PREFIX = "runtime:effect:index:case:";
export const RUNTIME_EFFECT_WORK_ITEM_INDEX_PREFIX = "runtime:effect:index:work-item:";
export const RUNTIME_EFFECT_DEPLOY_RECORD_INDEX_PREFIX = "runtime:effect:index:deploy-record:";
export const RUNTIME_EFFECT_SUBSCRIPTION_INDEX_PREFIX = "runtime:effect:index:subscription:";

export type RuntimeEffectKind =
  | "connector.send_message"
  | "event.publish"
  | "subscription.create"
  | "subscription.cancel"
  | "workitem.dispatch"
  | "workitem.complete"
  | "reminder.schedule"
  | "adapter.invoke"
  | "deploy.subscription.create"
  | "deploy.subscription.cancel"
  | "deploy.subscription.rollback";

export type RuntimeEffectStatus =
  | "pending"
  | "in_flight"
  | "succeeded"
  | "failed"
  | "retry"
  | "dead_letter"
  | "cancelled";

export const RUNTIME_EFFECT_OUTBOX_TRANSITIONS: Record<RuntimeEffectStatus, RuntimeEffectStatus[]> = {
  pending: ["in_flight", "cancelled", "dead_letter"],
  in_flight: ["succeeded", "failed", "retry", "dead_letter"],
  failed: ["retry", "dead_letter"],
  retry: ["in_flight", "cancelled", "dead_letter"],
  succeeded: [],
  dead_letter: [],
  cancelled: [],
};

export interface RuntimeEffectLinks {
  workflow_id?: string;
  deploy_version?: number;
  deployment_id?: string;
  deploy_record_key?: string;
  case_id?: string;
  work_item_id?: string;
  subscription_id?: string;
  event_id?: string;
  action_type?: string;
  action_trace_id?: string;
  connector_id?: string;
  adapter_id?: string;
}

export interface RuntimeEffectError {
  code: string;
  message: string;
  retryable: boolean;
  failed_at: string;
  details?: Record<string, unknown>;
}

export interface RuntimeEffectReceipt {
  status: "succeeded" | "failed" | "cancelled";
  received_at: string;
  data?: Record<string, unknown>;
}

export interface RuntimeEffectRetryPolicy {
  max_attempts: number;
  backoff: "fixed" | "exponential";
  retry_delays_ms: number[];
  dead_letter_after_attempts: number;
}

export interface RuntimeEffectRecord {
  schema_version: 1;
  effect_id: string;
  kind: RuntimeEffectKind;
  payload: Record<string, unknown>;
  idempotency_key: string;
  status: RuntimeEffectStatus;
  attempts: number;
  retry_policy: RuntimeEffectRetryPolicy;
  links: RuntimeEffectLinks;
  created_at: string;
  updated_at: string;
  next_retry_at?: string;
  locked_by?: string;
  locked_until?: string;
  completed_at?: string;
  error?: RuntimeEffectError;
  receipt?: RuntimeEffectReceipt;
}

export interface RuntimeEffectBuildInput {
  kind: RuntimeEffectKind;
  payload: Record<string, unknown>;
  idempotency_key: string;
  links: RuntimeEffectLinks;
  status?: RuntimeEffectStatus;
  attempts?: number;
  retry_policy?: Partial<RuntimeEffectRetryPolicy>;
  next_retry_at?: string;
  error?: RuntimeEffectError;
}

export interface DeploySubscriptionEffectInput {
  operation: "create" | "cancel" | "rollback";
  workflow_id: string;
  deploy_version: number;
  deployment_id: string;
  deploy_record_key: string;
  subscription: {
    event_id: string;
    event_label?: string;
    trigger_kind?: string;
    subscription_id?: string;
    previous_subscription_id?: string;
    operation_key: string;
    idempotency_key: string;
    status: string;
    reason?: string;
    error?: string;
  };
}

export interface RuntimeEffectStorageKeys {
  record_key: string;
  idempotency_key: string;
  status_index_key: string;
  case_index_key?: string;
  work_item_index_key?: string;
  deploy_record_index_key?: string;
  subscription_index_key?: string;
}

export const DEFAULT_RUNTIME_EFFECT_RETRY_POLICY: RuntimeEffectRetryPolicy = {
  max_attempts: 5,
  backoff: "exponential",
  retry_delays_ms: [1_000, 5_000, 30_000, 300_000, 900_000],
  dead_letter_after_attempts: 5,
};

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function assertNonEmpty(value: string | undefined, field: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${field} is required`);
  return trimmed;
}

function hasCorrelationLink(links: RuntimeEffectLinks): boolean {
  return Boolean(
    links.case_id?.trim() ||
    links.work_item_id?.trim() ||
    links.deploy_record_key?.trim() ||
    links.subscription_id?.trim() ||
    links.action_trace_id?.trim(),
  );
}

function assertIso(value: string, field: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${field} must be an ISO timestamp`);
}

function normalizeRetryPolicy(policy: Partial<RuntimeEffectRetryPolicy> | undefined): RuntimeEffectRetryPolicy {
  const merged = { ...DEFAULT_RUNTIME_EFFECT_RETRY_POLICY, ...(policy ?? {}) };
  if (!Number.isInteger(merged.max_attempts) || merged.max_attempts < 1) {
    throw new Error("retry_policy.max_attempts must be a positive integer");
  }
  if (!Number.isInteger(merged.dead_letter_after_attempts) || merged.dead_letter_after_attempts < 1) {
    throw new Error("retry_policy.dead_letter_after_attempts must be a positive integer");
  }
  if (!Array.isArray(merged.retry_delays_ms) || merged.retry_delays_ms.length === 0 || merged.retry_delays_ms.some(delay => !Number.isFinite(delay) || delay < 0)) {
    throw new Error("retry_policy.retry_delays_ms must contain non-negative delays");
  }
  return merged;
}

function assertAttemptsInRange(attempts: number, retryPolicy: RuntimeEffectRetryPolicy): void {
  if (!Number.isInteger(attempts) || attempts < 0) {
    throw new Error("attempts must be a non-negative integer");
  }
  if (attempts > retryPolicy.dead_letter_after_attempts) {
    throw new Error("attempts must not exceed retry_policy.dead_letter_after_attempts");
  }
}

function assertRuntimeEffectStatusInvariants(input: {
  status: RuntimeEffectStatus;
  attempts: number;
  retry_policy: RuntimeEffectRetryPolicy;
  next_retry_at?: string;
  error?: RuntimeEffectError;
}): void {
  assertAttemptsInRange(input.attempts, input.retry_policy);
  if (input.status === "retry" && !input.next_retry_at) {
    throw new Error("next_retry_at is required for retry status");
  }
  if ((input.status === "failed" || input.status === "dead_letter" || input.status === "retry") && !input.error) {
    throw new Error(`error is required for ${input.status} status`);
  }
  if (input.status === "in_flight" && input.attempts < 1) {
    throw new Error("attempts must be at least 1 for in_flight status");
  }
}

export function runtimeEffectIdFromIdempotencyKey(idempotencyKey: string): string {
  return `rte_${digest(assertNonEmpty(idempotencyKey, "idempotency_key"))}`;
}

export function runtimeEffectStorageKeys(record: Pick<RuntimeEffectRecord, "effect_id" | "idempotency_key" | "status" | "links">): RuntimeEffectStorageKeys {
  return {
    record_key: `${RUNTIME_EFFECT_KEY_PREFIX}${record.effect_id}`,
    idempotency_key: `${RUNTIME_EFFECT_IDEMPOTENCY_KEY_PREFIX}${digest(record.idempotency_key)}`,
    status_index_key: `${RUNTIME_EFFECT_STATUS_INDEX_PREFIX}${record.status}`,
    ...(record.links.case_id ? { case_index_key: `${RUNTIME_EFFECT_CASE_INDEX_PREFIX}${record.links.case_id}` } : {}),
    ...(record.links.work_item_id ? { work_item_index_key: `${RUNTIME_EFFECT_WORK_ITEM_INDEX_PREFIX}${record.links.work_item_id}` } : {}),
    ...(record.links.deploy_record_key ? { deploy_record_index_key: `${RUNTIME_EFFECT_DEPLOY_RECORD_INDEX_PREFIX}${digest(record.links.deploy_record_key)}` } : {}),
    ...(record.links.subscription_id ? { subscription_index_key: `${RUNTIME_EFFECT_SUBSCRIPTION_INDEX_PREFIX}${record.links.subscription_id}` } : {}),
  };
}

export function assertRuntimeEffectTransition(from: RuntimeEffectStatus, to: RuntimeEffectStatus): void {
  if (!RUNTIME_EFFECT_OUTBOX_TRANSITIONS[from]?.includes(to)) {
    throw new Error(`invalid runtime effect transition: ${from} -> ${to}`);
  }
}

export function buildRuntimeEffectRecord(input: RuntimeEffectBuildInput, now = new Date().toISOString()): RuntimeEffectRecord {
  assertIso(now, "now");
  const idempotency_key = assertNonEmpty(input.idempotency_key, "idempotency_key");
  if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) {
    throw new Error("payload must be an object");
  }
  if (!hasCorrelationLink(input.links)) {
    throw new Error("links must include case_id, work_item_id, deploy_record_key, subscription_id, or action_trace_id");
  }
  if (input.next_retry_at) assertIso(input.next_retry_at, "next_retry_at");
  if (input.error) assertIso(input.error.failed_at, "error.failed_at");
  const status = input.status ?? "pending";
  const attempts = input.attempts ?? 0;
  const retry_policy = normalizeRetryPolicy(input.retry_policy);
  assertRuntimeEffectStatusInvariants({
    status,
    attempts,
    retry_policy,
    next_retry_at: input.next_retry_at,
    error: input.error,
  });

  return {
    schema_version: RUNTIME_EFFECT_OUTBOX_SCHEMA_VERSION,
    effect_id: runtimeEffectIdFromIdempotencyKey(idempotency_key),
    kind: input.kind,
    payload: input.payload,
    idempotency_key,
    status,
    attempts,
    retry_policy,
    links: input.links,
    created_at: now,
    updated_at: now,
    ...(input.next_retry_at ? { next_retry_at: input.next_retry_at } : {}),
    ...(input.error ? { error: input.error } : {}),
  };
}

export function transitionRuntimeEffectRecord(
  record: RuntimeEffectRecord,
  update: {
    status: RuntimeEffectStatus;
    now?: string;
    worker_id?: string;
    lock_ms?: number;
    next_retry_at?: string;
    error?: Omit<RuntimeEffectError, "failed_at"> & { failed_at?: string };
    receipt?: Omit<RuntimeEffectReceipt, "received_at"> & { received_at?: string };
  },
): RuntimeEffectRecord {
  const now = update.now ?? new Date().toISOString();
  assertIso(now, "now");
  assertRuntimeEffectTransition(record.status, update.status);
  if (update.next_retry_at) assertIso(update.next_retry_at, "next_retry_at");
  if (update.status === "retry" && !update.next_retry_at) {
    throw new Error("next_retry_at is required for retry status");
  }
  if ((update.status === "failed" || update.status === "dead_letter" || update.status === "retry") && !update.error) {
    throw new Error(`error is required for ${update.status} status`);
  }

  const next: RuntimeEffectRecord = {
    ...record,
    status: update.status,
    updated_at: now,
  };

  delete next.locked_by;
  delete next.locked_until;
  delete next.next_retry_at;

  if (update.status === "in_flight") {
    next.attempts = record.attempts + 1;
    if (update.worker_id) next.locked_by = update.worker_id;
    if (update.lock_ms && update.lock_ms > 0) {
      next.locked_until = new Date(Date.parse(now) + update.lock_ms).toISOString();
    }
  }

  if (update.status === "retry") next.next_retry_at = update.next_retry_at;
  if (update.error) {
    next.error = {
      ...update.error,
      failed_at: update.error.failed_at ?? now,
    };
  }
  if (update.receipt) {
    next.receipt = {
      ...update.receipt,
      received_at: update.receipt.received_at ?? now,
    };
  }
  if (update.status === "succeeded" || update.status === "dead_letter" || update.status === "cancelled") {
    next.completed_at = now;
  } else {
    delete next.completed_at;
  }

  return next;
}

export function buildDeploySubscriptionRuntimeEffect(
  input: DeploySubscriptionEffectInput,
  now = new Date().toISOString(),
): RuntimeEffectRecord {
  const subscriptionId = input.subscription.subscription_id ?? input.subscription.previous_subscription_id;
  return buildRuntimeEffectRecord({
    kind: `deploy.subscription.${input.operation}` as RuntimeEffectKind,
    idempotency_key: input.subscription.idempotency_key,
    payload: {
      operation: input.operation,
      event_id: input.subscription.event_id,
      event_label: input.subscription.event_label,
      trigger_kind: input.subscription.trigger_kind,
      operation_key: input.subscription.operation_key,
      subscription_status: input.subscription.status,
      reason: input.subscription.reason,
      error: input.subscription.error,
    },
    links: {
      workflow_id: input.workflow_id,
      deploy_version: input.deploy_version,
      deployment_id: input.deployment_id,
      deploy_record_key: input.deploy_record_key,
      event_id: input.subscription.event_id,
      ...(subscriptionId ? { subscription_id: subscriptionId } : {}),
    },
  }, now);
}
