import { describe, expect, test } from "bun:test";
import {
  buildDeploySubscriptionRuntimeEffect,
  buildRuntimeEffectRecord,
  RUNTIME_EFFECT_OUTBOX_TRANSITIONS,
  runtimeEffectIdFromIdempotencyKey,
  runtimeEffectStorageKeys,
  transitionRuntimeEffectRecord,
} from "../src/runtime-effect-outbox";

describe("runtime effect outbox model", () => {
  test("builds deterministic durable records with required outbox fields and indexes", () => {
    const now = "2026-05-21T19:45:00.000Z";
    const record = buildRuntimeEffectRecord({
      kind: "connector.send_message",
      idempotency_key: "connector:telegram:case-1:work-item-1",
      payload: { connector_id: "telegram-main", chat_ref: "42", text: "hello" },
      links: {
        workflow_id: "workflow-1",
        case_id: "case-1",
        work_item_id: "work-item-1",
        action_trace_id: "trace-1",
        connector_id: "telegram-main",
      },
    }, now);

    expect(record).toEqual({
      schema_version: 1,
      effect_id: runtimeEffectIdFromIdempotencyKey("connector:telegram:case-1:work-item-1"),
      kind: "connector.send_message",
      payload: { connector_id: "telegram-main", chat_ref: "42", text: "hello" },
      idempotency_key: "connector:telegram:case-1:work-item-1",
      status: "pending",
      attempts: 0,
      retry_policy: {
        max_attempts: 5,
        backoff: "exponential",
        retry_delays_ms: [1_000, 5_000, 30_000, 300_000, 900_000],
        dead_letter_after_attempts: 5,
      },
      links: {
        workflow_id: "workflow-1",
        case_id: "case-1",
        work_item_id: "work-item-1",
        action_trace_id: "trace-1",
        connector_id: "telegram-main",
      },
      created_at: now,
      updated_at: now,
    });

    expect(runtimeEffectStorageKeys(record)).toMatchObject({
      record_key: `runtime:effect:${record.effect_id}`,
      status_index_key: "runtime:effect:index:status:pending",
      case_index_key: "runtime:effect:index:case:case-1",
      work_item_index_key: "runtime:effect:index:work-item:work-item-1",
    });
    expect(runtimeEffectStorageKeys(record).idempotency_key).toMatch(/^runtime:effect:idempotency:[a-f0-9]{24}$/);
  });

  test("rejects records without idempotency, object payload, or correlation link", () => {
    expect(() => buildRuntimeEffectRecord({
      kind: "event.publish",
      idempotency_key: "",
      payload: {},
      links: { case_id: "case-1" },
    })).toThrow("idempotency_key is required");

    expect(() => buildRuntimeEffectRecord({
      kind: "event.publish",
      idempotency_key: "event-1",
      payload: [] as any,
      links: { case_id: "case-1" },
    })).toThrow("payload must be an object");

    expect(() => buildRuntimeEffectRecord({
      kind: "event.publish",
      idempotency_key: "event-1",
      payload: {},
      links: { workflow_id: "workflow-1" },
    })).toThrow("links must include");
  });

  test("defines retry/dead-letter state machine and terminal states", () => {
    expect(RUNTIME_EFFECT_OUTBOX_TRANSITIONS).toMatchObject({
      pending: ["in_flight", "cancelled", "dead_letter"],
      in_flight: ["succeeded", "failed", "retry", "dead_letter"],
      failed: ["retry", "dead_letter"],
      retry: ["in_flight", "cancelled", "dead_letter"],
      succeeded: [],
      dead_letter: [],
      cancelled: [],
    });

    const pending = buildRuntimeEffectRecord({
      kind: "workitem.dispatch",
      idempotency_key: "dispatch:case-1:work-item-1",
      payload: { role: "reviewer" },
      links: { case_id: "case-1", work_item_id: "work-item-1" },
    }, "2026-05-21T19:45:00.000Z");

    const inFlight = transitionRuntimeEffectRecord(pending, {
      status: "in_flight",
      now: "2026-05-21T19:45:01.000Z",
      worker_id: "outbox-worker-1",
      lock_ms: 30_000,
    });
    expect(inFlight).toMatchObject({
      status: "in_flight",
      attempts: 1,
      locked_by: "outbox-worker-1",
      locked_until: "2026-05-21T19:45:31.000Z",
    });

    const retry = transitionRuntimeEffectRecord(inFlight, {
      status: "retry",
      now: "2026-05-21T19:45:02.000Z",
      next_retry_at: "2026-05-21T19:46:02.000Z",
      error: {
        code: "DISPATCH_TARGET_OFFLINE",
        message: "reviewer is offline",
        retryable: true,
      },
    });
    expect(retry).toMatchObject({
      status: "retry",
      attempts: 1,
      next_retry_at: "2026-05-21T19:46:02.000Z",
      error: {
        code: "DISPATCH_TARGET_OFFLINE",
        failed_at: "2026-05-21T19:45:02.000Z",
        retryable: true,
      },
    });
    expect(retry.locked_by).toBeUndefined();
    expect(retry.locked_until).toBeUndefined();

    const secondAttempt = transitionRuntimeEffectRecord(retry, {
      status: "in_flight",
      now: "2026-05-21T19:46:02.000Z",
    });
    expect(secondAttempt.attempts).toBe(2);
    expect(secondAttempt.next_retry_at).toBeUndefined();

    const succeeded = transitionRuntimeEffectRecord(secondAttempt, {
      status: "succeeded",
      now: "2026-05-21T19:46:03.000Z",
      receipt: {
        status: "succeeded",
        data: { message_id: "msg-1" },
      },
    });
    expect(succeeded).toMatchObject({
      status: "succeeded",
      completed_at: "2026-05-21T19:46:03.000Z",
      receipt: {
        status: "succeeded",
        received_at: "2026-05-21T19:46:03.000Z",
        data: { message_id: "msg-1" },
      },
    });
    expect(() => transitionRuntimeEffectRecord(succeeded, { status: "retry" })).toThrow("invalid runtime effect transition");
  });

  test("builds deploy subscription effects aligned with deploy record idempotency and correlation", () => {
    const effect = buildDeploySubscriptionRuntimeEffect({
      operation: "rollback",
      workflow_id: "workflow-1",
      deploy_version: 3,
      deployment_id: "workflow-1:v3",
      deploy_record_key: "workflow:deploy-record:workflow-1:v3",
      subscription: {
        event_id: "start",
        event_label: "Start",
        trigger_kind: "timer",
        previous_subscription_id: "sub-1",
        operation_key: "workflow-1:v3:start",
        idempotency_key: "workflow.deploy:workflow-1:v3:subscription:rollback:start",
        status: "failed",
        reason: "rollback_failed_deploy_materialization",
        error: "simulated cancel failure",
      },
    }, "2026-05-21T19:45:00.000Z");

    expect(effect).toMatchObject({
      kind: "deploy.subscription.rollback",
      idempotency_key: "workflow.deploy:workflow-1:v3:subscription:rollback:start",
      status: "pending",
      links: {
        workflow_id: "workflow-1",
        deploy_version: 3,
        deployment_id: "workflow-1:v3",
        deploy_record_key: "workflow:deploy-record:workflow-1:v3",
        subscription_id: "sub-1",
        event_id: "start",
      },
      payload: {
        operation: "rollback",
        event_id: "start",
        operation_key: "workflow-1:v3:start",
        subscription_status: "failed",
        reason: "rollback_failed_deploy_materialization",
        error: "simulated cancel failure",
      },
    });
    expect(runtimeEffectStorageKeys(effect)).toMatchObject({
      deploy_record_index_key: expect.stringMatching(/^runtime:effect:index:deploy-record:[a-f0-9]{24}$/),
      subscription_index_key: "runtime:effect:index:subscription:sub-1",
    });
  });
});
