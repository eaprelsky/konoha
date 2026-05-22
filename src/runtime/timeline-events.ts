import { createHash } from "crypto";
import { redis } from "../redis";
import { createLogger } from "../logger";
import { emitEvent, type RuntimeEvent } from "./event-log";
import type { RuntimeEffectRecord, RuntimeEffectRecoveryReceipt, RuntimeEffectStatus } from "../runtime-effect-outbox";
import type { WorkflowDeploymentRecord } from "../workflow-deployment-service";

const log = createLogger("runtime-timeline-events");

export const TIMELINE_EVENT_IDEMPOTENCY_KEY_PREFIX = "runtime:timeline-event:idempotency:";
const TIMELINE_EVENT_IDEMPOTENCY_TTL_SECONDS = 30 * 24 * 60 * 60;

export type RuntimeEffectTimelineEventType =
  | "runtime.effect.enqueued"
  | "runtime.effect.claimed"
  | "runtime.effect.succeeded"
  | "runtime.effect.retry_scheduled"
  | "runtime.effect.dead_lettered"
  | "runtime.effect.cancelled"
  | "runtime.effect.recovery";

export type WorkflowDeployTimelineEventType =
  | "workflow.deploy.receipt";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

async function emitTimelineEventOnce(
  idempotencyKey: string,
  event: Omit<RuntimeEvent, "id">,
): Promise<boolean> {
  const redisKey = `${TIMELINE_EVENT_IDEMPOTENCY_KEY_PREFIX}${digest(idempotencyKey)}`;
  try {
    const claimed = await redis.set(
      redisKey,
      String(event.timestamp),
      "EX",
      TIMELINE_EVENT_IDEMPOTENCY_TTL_SECONDS,
      "NX",
    );
    if (claimed !== "OK") return false;
    await emitEvent({
      ...event,
      timeline_event_id: digest(idempotencyKey),
      timeline_idempotency_key: idempotencyKey,
    });
    return true;
  } catch (e: any) {
    log.warn("failed to emit timeline event", {
      type: event.type,
      timeline_idempotency_key: idempotencyKey,
      error: e?.message ?? String(e),
    });
    return false;
  }
}

function effectEventTypeForStatus(status: RuntimeEffectStatus): RuntimeEffectTimelineEventType {
  switch (status) {
    case "pending":
      return "runtime.effect.enqueued";
    case "in_flight":
      return "runtime.effect.claimed";
    case "succeeded":
      return "runtime.effect.succeeded";
    case "retry":
      return "runtime.effect.retry_scheduled";
    case "dead_letter":
      return "runtime.effect.dead_lettered";
    case "cancelled":
      return "runtime.effect.cancelled";
    case "failed":
      return "runtime.effect.retry_scheduled";
  }
}

function runtimeEffectBaseEvent(record: RuntimeEffectRecord, type: RuntimeEffectTimelineEventType): Omit<RuntimeEvent, "id"> {
  return {
    type,
    timestamp: record.updated_at,
    case_id: record.links.case_id,
    process_id: record.links.workflow_id,
    work_item_id: record.links.work_item_id,
    effect_id: record.effect_id,
    effect_kind: record.kind,
    effect_status: record.status,
    attempts: record.attempts,
    idempotency_key: record.idempotency_key,
    deploy_version: record.links.deploy_version,
    deployment_id: record.links.deployment_id,
    deploy_record_key: record.links.deploy_record_key,
    subscription_id: record.links.subscription_id,
    event_id: record.links.event_id,
    action_trace_id: record.links.action_trace_id,
    connector_id: record.links.connector_id,
    adapter_id: record.links.adapter_id,
    next_retry_at: record.next_retry_at,
    locked_by: record.locked_by,
    locked_until: record.locked_until,
    completed_at: record.completed_at,
    error_code: record.error?.code,
    error_retryable: record.error?.retryable,
    receipt_status: record.receipt?.status,
  };
}

export async function emitRuntimeEffectTimelineEvent(
  record: RuntimeEffectRecord,
  options: {
    previous_status?: RuntimeEffectStatus;
    event_type?: RuntimeEffectTimelineEventType;
  } = {},
): Promise<boolean> {
  const type = options.event_type ?? effectEventTypeForStatus(record.status);
  const statusKey = type === "runtime.effect.enqueued"
    ? "enqueued"
    : `${record.status}:${record.attempts}:${record.error?.code ?? record.receipt?.status ?? "none"}`;
  return emitTimelineEventOnce(
    `runtime.effect:${record.effect_id}:${statusKey}`,
    {
      ...runtimeEffectBaseEvent(record, type),
      previous_status: options.previous_status,
    },
  );
}

export async function emitRuntimeEffectRecoveryTimelineEvent(
  receipt: RuntimeEffectRecoveryReceipt,
): Promise<boolean> {
  const eventType = receipt.noop ? "runtime.effect.recovery" : effectEventTypeForStatus(receipt.record.status);
  return emitTimelineEventOnce(
    `runtime.effect:${receipt.effect_id}:recovery:${receipt.operation}:${receipt.from_status}:${receipt.to_status}:${receipt.recovered_at}`,
    {
      ...runtimeEffectBaseEvent(receipt.record, eventType),
      timestamp: receipt.recovered_at,
      previous_status: receipt.from_status,
      recovery_operation: receipt.operation,
      recovery_actor: receipt.actor,
      recovery_reason: receipt.reason,
      recovery_noop: receipt.noop,
      recovery_terminal_override: receipt.terminal_override,
      recovery_audited: receipt.audited,
      recovery_audit_session_id: receipt.audit.session_id,
      recovery_audit_action_type: receipt.audit.action_type,
      recovery_audit_entry_id: receipt.audit.entry_id,
      recovery_source: receipt.recovery_source,
      recovery_request_path: receipt.request_path,
      previous_attempts: receipt.previous_attempts,
    },
  );
}

export async function emitWorkflowDeployReceiptTimelineEvent(
  record: WorkflowDeploymentRecord,
): Promise<boolean> {
  return emitTimelineEventOnce(
    `workflow.deploy:${record.record_key}:receipt:${record.status}`,
    {
      type: "workflow.deploy.receipt",
      timestamp: record.completed_at,
      process_id: record.workflow_id,
      workflow_id: record.workflow_id,
      deploy_version: record.deploy_version,
      deployment_id: record.deployment_id,
      deploy_record_key: record.record_key,
      deploy_status: record.status,
      deploy_source: record.source,
      deployed_at: record.deployed_at,
      deployed_by: record.deployed_by,
      transaction_id: record.transaction.transaction_id,
      transaction_status: record.transaction.status,
      transaction_idempotency_key: record.transaction.idempotency_key,
      caller_idempotency_key: record.transaction.caller_idempotency_key,
      subscriptions_desired: record.subscription_diff.desired,
      subscriptions_created: record.subscription_diff.created.length,
      subscriptions_cancelled: record.subscription_diff.cancelled.length,
      subscriptions_unchanged: record.subscription_diff.unchanged.length,
      subscriptions_failed: record.subscription_diff.failed.length,
      subscriptions_rollback: record.subscription_diff.rollback?.length ?? 0,
      failure_code: record.failure?.code,
      failure_message: record.failure?.message,
    },
  );
}
