import { describe, expect, test } from "bun:test";
import {
  buildDeploySubscriptionRuntimeEffect,
  buildRuntimeEffectRecord,
  claimNextRuntimeEffect,
  completeRuntimeEffect,
  enqueueRuntimeEffect,
  getRuntimeEffect,
  listRuntimeEffectsByStatus,
  processRuntimeEffectOutboxOnce,
  RUNTIME_EFFECT_OUTBOX_TRANSITIONS,
  runtimeEffectIdFromIdempotencyKey,
  runtimeEffectStorageKeys,
  transitionRuntimeEffectRecord,
} from "../src/runtime-effect-outbox";

const RUN = `runtime-effect-outbox-${Date.now()}`;

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

  test("rejects invalid direct-build retry and dead-letter states", () => {
    const base = {
      kind: "event.publish" as const,
      idempotency_key: "event-1",
      payload: {},
      links: { case_id: "case-1" },
    };

    expect(() => buildRuntimeEffectRecord({
      ...base,
      status: "retry",
    }, "2026-05-21T19:55:00.000Z")).toThrow("next_retry_at is required for retry status");

    expect(() => buildRuntimeEffectRecord({
      ...base,
      status: "retry",
      next_retry_at: "2026-05-21T19:56:00.000Z",
    }, "2026-05-21T19:55:00.000Z")).toThrow("error is required for retry status");

    expect(() => buildRuntimeEffectRecord({
      ...base,
      status: "failed",
    }, "2026-05-21T19:55:00.000Z")).toThrow("error is required for failed status");

    expect(() => buildRuntimeEffectRecord({
      ...base,
      status: "dead_letter",
    }, "2026-05-21T19:55:00.000Z")).toThrow("error is required for dead_letter status");

    expect(() => buildRuntimeEffectRecord({
      ...base,
      status: "in_flight",
    }, "2026-05-21T19:55:00.000Z")).toThrow("attempts must be at least 1 for in_flight status");

    expect(() => buildRuntimeEffectRecord({
      ...base,
      attempts: -1,
    }, "2026-05-21T19:55:00.000Z")).toThrow("attempts must be a non-negative integer");

    expect(() => buildRuntimeEffectRecord({
      ...base,
      attempts: 6,
    }, "2026-05-21T19:55:00.000Z")).toThrow("attempts must not exceed retry_policy.dead_letter_after_attempts");
  });

  test("builds valid non-pending records only with required retry/error evidence", () => {
    const retry = buildRuntimeEffectRecord({
      kind: "event.publish",
      idempotency_key: "event-1",
      payload: {},
      links: { case_id: "case-1" },
      status: "retry",
      attempts: 1,
      next_retry_at: "2026-05-21T19:56:00.000Z",
      error: {
        code: "EVENT_BUS_UNAVAILABLE",
        message: "bus unavailable",
        retryable: true,
        failed_at: "2026-05-21T19:55:00.000Z",
      },
    }, "2026-05-21T19:55:00.000Z");
    expect(retry).toMatchObject({
      status: "retry",
      attempts: 1,
      next_retry_at: "2026-05-21T19:56:00.000Z",
      error: {
        code: "EVENT_BUS_UNAVAILABLE",
        retryable: true,
      },
    });

    const deadLetter = buildRuntimeEffectRecord({
      kind: "event.publish",
      idempotency_key: "event-2",
      payload: {},
      links: { case_id: "case-1" },
      status: "dead_letter",
      attempts: 5,
      error: {
        code: "EVENT_BUS_REJECTED",
        message: "bus rejected event",
        retryable: false,
        failed_at: "2026-05-21T19:55:00.000Z",
      },
    }, "2026-05-21T19:55:00.000Z");
    expect(deadLetter).toMatchObject({
      status: "dead_letter",
      attempts: 5,
      error: {
        code: "EVENT_BUS_REJECTED",
        retryable: false,
      },
    });
  });

  test("rejects retry transition to in_flight after max attempts", () => {
    const maxRetry = buildRuntimeEffectRecord({
      kind: "event.publish",
      idempotency_key: "max",
      payload: {},
      links: { case_id: "case-1" },
      status: "retry",
      attempts: 5,
      next_retry_at: "2026-05-21T19:56:00.000Z",
      error: {
        code: "EVENT_BUS_UNAVAILABLE",
        message: "bus unavailable",
        retryable: true,
        failed_at: "2026-05-21T19:55:00.000Z",
      },
    }, "2026-05-21T19:55:00.000Z");

    expect(() => transitionRuntimeEffectRecord(maxRetry, {
      status: "in_flight",
      now: "2026-05-21T19:56:00.000Z",
    })).toThrow("attempts must not exceed retry_policy.dead_letter_after_attempts");

    const deadLetter = transitionRuntimeEffectRecord(maxRetry, {
      status: "dead_letter",
      now: "2026-05-21T19:56:00.000Z",
      error: {
        code: "EVENT_BUS_UNAVAILABLE",
        message: "retry budget exhausted",
        retryable: false,
      },
    });
    expect(deadLetter).toMatchObject({
      status: "dead_letter",
      attempts: 5,
      completed_at: "2026-05-21T19:56:00.000Z",
      error: {
        code: "EVENT_BUS_UNAVAILABLE",
        retryable: false,
      },
    });
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

  test("enqueues records durably and suppresses duplicate idempotency keys", async () => {
    const first = await enqueueRuntimeEffect({
      kind: "connector.send_message",
      idempotency_key: `${RUN}:dedup`,
      payload: { text: "first" },
      links: { case_id: `${RUN}:case-dedup` },
    }, "2026-05-21T20:15:00.000Z");
    const second = await enqueueRuntimeEffect({
      kind: "connector.send_message",
      idempotency_key: `${RUN}:dedup`,
      payload: { text: "second" },
      links: { case_id: `${RUN}:case-dedup` },
    }, "2026-05-21T20:15:01.000Z");

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.record.effect_id).toBe(first.record.effect_id);
    expect(second.record.payload).toEqual({ text: "first" });

    const pending = await listRuntimeEffectsByStatus("pending", { now: "2026-05-21T20:15:02.000Z" });
    expect(pending.some(record => record.effect_id === first.record.effect_id)).toBe(true);
    await expect(getRuntimeEffect(first.record.effect_id)).resolves.toMatchObject({
      effect_id: first.record.effect_id,
      status: "pending",
      attempts: 0,
    });
    const claimed = await claimNextRuntimeEffect({
      worker_id: "cleanup-worker",
      now: "2026-05-21T20:15:03.000Z",
    });
    expect(claimed?.effect_id).toBe(first.record.effect_id);
    await completeRuntimeEffect(claimed!, { data: { cleanup: true } }, "2026-05-21T20:15:04.000Z");
  });

  test("claims one pending effect with a lock and completes it once", async () => {
    const enqueued = await enqueueRuntimeEffect({
      kind: "workitem.dispatch",
      idempotency_key: `${RUN}:claim-success`,
      payload: { role: "reviewer" },
      links: { case_id: `${RUN}:case-claim`, work_item_id: `${RUN}:work-item-claim` },
    }, "2026-05-21T20:16:00.000Z");

    const claimed = await claimNextRuntimeEffect({
      worker_id: "worker-1",
      now: "2026-05-21T20:16:01.000Z",
      lock_ms: 60_000,
    });
    expect(claimed).toMatchObject({
      effect_id: enqueued.record.effect_id,
      status: "in_flight",
      attempts: 1,
      locked_by: "worker-1",
      locked_until: "2026-05-21T20:17:01.000Z",
    });

    const lockedAgain = await claimNextRuntimeEffect({
      worker_id: "worker-2",
      now: "2026-05-21T20:16:02.000Z",
    });
    expect(lockedAgain?.effect_id).not.toBe(enqueued.record.effect_id);

    const completed = await completeRuntimeEffect(claimed!, { data: { dispatch_id: "dispatch-1" } }, "2026-05-21T20:16:03.000Z");
    expect(completed).toMatchObject({
      effect_id: enqueued.record.effect_id,
      status: "succeeded",
      receipt: {
        status: "succeeded",
        data: { dispatch_id: "dispatch-1" },
      },
    });

    const current = await getRuntimeEffect(enqueued.record.effect_id);
    expect(current).toMatchObject({
      status: "succeeded",
      attempts: 1,
    });
    expect(current?.locked_by).toBeUndefined();
  });

  test("worker success, retry, and dead-letter paths preserve bounded attempts", async () => {
    const success = await enqueueRuntimeEffect({
      kind: "event.publish",
      idempotency_key: `${RUN}:worker-success`,
      payload: { event: "ok" },
      links: { case_id: `${RUN}:case-worker-success` },
    }, "2026-05-21T20:17:00.000Z");
    const successResult = await processRuntimeEffectOutboxOnce({
      worker_id: "worker-success",
      now: "2026-05-21T20:17:01.000Z",
    }, async record => ({
      receipt: { data: { handled_effect_id: record.effect_id } },
    }));
    expect(successResult).toMatchObject({
      outcome: "succeeded",
      final_record: {
        effect_id: success.record.effect_id,
        status: "succeeded",
        attempts: 1,
        completed_at: "2026-05-21T20:17:01.000Z",
        receipt: {
          status: "succeeded",
          data: { handled_effect_id: success.record.effect_id },
        },
      },
    });

    const retry = await enqueueRuntimeEffect({
      kind: "event.publish",
      idempotency_key: `${RUN}:worker-retry`,
      payload: { event: "retry" },
      links: { case_id: `${RUN}:case-worker-retry` },
      retry_policy: { retry_delays_ms: [1_000], dead_letter_after_attempts: 2, max_attempts: 2 },
    }, "2026-05-21T20:18:00.000Z");
    const retryResult = await processRuntimeEffectOutboxOnce({
      worker_id: "worker-retry",
      now: "2026-05-21T20:18:01.000Z",
    }, async () => {
      const error = new Error("temporary failure") as Error & { code: string; retryable: boolean };
      error.code = "TEMPORARY_FAILURE";
      error.retryable = true;
      throw error;
    });
    expect(retryResult).toMatchObject({
      outcome: "retry",
      final_record: {
        effect_id: retry.record.effect_id,
        status: "retry",
        attempts: 1,
        next_retry_at: "2026-05-21T20:18:02.000Z",
        error: {
          code: "TEMPORARY_FAILURE",
          retryable: true,
        },
      },
    });

    const earlyRetryClaim = await claimNextRuntimeEffect({
      worker_id: "worker-early",
      now: "2026-05-21T20:18:01.500Z",
    });
    expect(earlyRetryClaim?.effect_id).not.toBe(retry.record.effect_id);

    const deadLetterResult = await processRuntimeEffectOutboxOnce({
      worker_id: "worker-retry",
      now: "2026-05-21T20:18:02.000Z",
    }, async () => {
      const error = new Error("permanent failure") as Error & { code: string; retryable: boolean };
      error.code = "PERMANENT_FAILURE";
      error.retryable = true;
      throw error;
    });
    expect(deadLetterResult).toMatchObject({
      outcome: "dead_letter",
      final_record: {
        effect_id: retry.record.effect_id,
        status: "dead_letter",
        attempts: 2,
        completed_at: "2026-05-21T20:18:02.000Z",
        error: {
          code: "PERMANENT_FAILURE",
          retryable: false,
        },
      },
    });
  });
});
