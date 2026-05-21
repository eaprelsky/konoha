import { afterAll, describe, expect, test } from "bun:test";
import { readAuditLog } from "../src/assistant-actions";
import {
  buildRuntimeEffectRecord,
  enqueueRuntimeEffect,
  getRuntimeEffect,
  recoverRuntimeEffect,
  runtimeEffectIdFromIdempotencyKey,
} from "../src/runtime-effect-outbox";

const RUN = `runtime-effect-recovery-${Date.now()}`;
const TEST_ADMIN_TOKEN = process.env.KONOHA_TOKEN || "test-admin-token-preload";
process.env.KONOHA_PORT = "0";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-anthropic-key";

const { app } = await import("../core/src/server");

function recoveryRecord(id: string, status: "failed" | "dead_letter") {
  return buildRuntimeEffectRecord({
    kind: "workitem.dispatch",
    idempotency_key: `${RUN}:${id}`,
    payload: { role: "reviewer", subject: id },
    links: { case_id: `${RUN}:case:${id}`, work_item_id: `${RUN}:work:${id}` },
    status,
    attempts: status === "dead_letter" ? 5 : 1,
    error: {
      code: "TEST_EFFECT_FAILED",
      message: "test effect failed",
      retryable: status !== "dead_letter",
      failed_at: "2026-05-21T22:20:00.000Z",
    },
  }, "2026-05-21T22:20:00.000Z");
}

function adminHeaders() {
  return { Authorization: `Bearer ${TEST_ADMIN_TOKEN}`, "Content-Type": "application/json" };
}

afterAll(() => {
  delete process.env.KONOHA_PORT;
});

describe("runtime effect recovery", () => {
  test("cancels pending effects with audit receipt and keeps terminal indexes consistent", async () => {
    const enqueued = await enqueueRuntimeEffect({
      kind: "workitem.dispatch",
      idempotency_key: `${RUN}:cancel-pending`,
      payload: { role: "reviewer" },
      links: { case_id: `${RUN}:case-cancel`, work_item_id: `${RUN}:work-cancel` },
    }, "2026-05-21T22:21:00.000Z");

    const receipt = await recoverRuntimeEffect(enqueued.record.effect_id, {
      operation: "cancel",
      actor: "kakashi",
      reason: "case cancelled by operator",
      now: "2026-05-21T22:21:01.000Z",
    });

    expect(receipt).toMatchObject({
      ok: true,
      operation: "cancel",
      from_status: "pending",
      to_status: "cancelled",
      noop: false,
      audited: true,
      record: {
        status: "cancelled",
        receipt: {
          status: "cancelled",
          data: { actor: "kakashi", reason: "case cancelled by operator" },
        },
      },
    });
    await expect(getRuntimeEffect(enqueued.record.effect_id)).resolves.toMatchObject({
      status: "cancelled",
      completed_at: "2026-05-21T22:21:01.000Z",
    });

    const audit = await readAuditLog({ actionType: "runtime_effect.cancel", limit: 20 });
    expect(audit.some(entry => entry.session_id === `runtime-effect-recovery:${enqueued.record.effect_id}` && entry.agent_chain === "kakashi")).toBe(true);
  });

  test("moves pending effects to dead letter with machine-readable operator evidence", async () => {
    const enqueued = await enqueueRuntimeEffect({
      kind: "reminder.schedule",
      idempotency_key: `${RUN}:dead-letter-pending`,
      payload: { reminder_id: `${RUN}:reminder` },
      links: { action_trace_id: `${RUN}:reminder` },
    }, "2026-05-21T22:22:00.000Z");

    const receipt = await recoverRuntimeEffect(enqueued.record.effect_id, {
      operation: "dead_letter",
      actor: "kakashi",
      reason: "payload cannot be delivered",
      now: "2026-05-21T22:22:01.000Z",
    });

    expect(receipt.record).toMatchObject({
      status: "dead_letter",
      error: {
        code: "RUNTIME_EFFECT_OPERATOR_DEAD_LETTER",
        retryable: false,
        details: {
          actor: "kakashi",
          reason: "payload cannot be delivered",
          previous_status: "pending",
        },
      },
    });
  });

  test("requeues failed and dead-lettered effects without exceeding retry budget", async () => {
    const failed = recoveryRecord("failed-retry", "failed");
    const deadLetter = recoveryRecord("dead-letter-retry", "dead_letter");
    await enqueueRuntimeEffect(failed);
    await enqueueRuntimeEffect(deadLetter);

    const failedReceipt = await recoverRuntimeEffect(failed.effect_id, {
      operation: "retry",
      actor: "kakashi",
      reason: "transient target restored",
      now: "2026-05-21T22:23:00.000Z",
    });
    expect(failedReceipt).toMatchObject({
      from_status: "failed",
      to_status: "retry",
      terminal_override: false,
      record: {
        status: "retry",
        attempts: 1,
        next_retry_at: "2026-05-21T22:23:00.000Z",
        error: { code: "RUNTIME_EFFECT_OPERATOR_RETRY", retryable: true },
      },
    });

    const deadLetterReceipt = await recoverRuntimeEffect(deadLetter.effect_id, {
      operation: "retry",
      actor: "kakashi",
      reason: "operator confirmed idempotent replay",
      now: "2026-05-21T22:23:01.000Z",
    });
    expect(deadLetterReceipt).toMatchObject({
      from_status: "dead_letter",
      to_status: "pending",
      terminal_override: true,
      previous_attempts: 5,
      attempts: 0,
      record: {
        status: "pending",
        attempts: 0,
        error: { code: "RUNTIME_EFFECT_OPERATOR_RETRY", retryable: true },
      },
    });

    await expect(getRuntimeEffect(failed.effect_id)).resolves.toMatchObject({ status: "retry" });
    await expect(getRuntimeEffect(deadLetter.effect_id)).resolves.toMatchObject({ status: "pending", attempts: 0 });
  });

  test("does not override active worker claims", async () => {
    const pending = buildRuntimeEffectRecord({
      kind: "event.publish",
      idempotency_key: `${RUN}:active-claim`,
      payload: { event: "active" },
      links: { action_trace_id: `${RUN}:active-claim` },
    }, "2026-05-21T22:24:00.000Z");
    const inFlight = {
      ...pending,
      status: "in_flight" as const,
      attempts: 1,
      updated_at: "2026-05-21T22:24:01.000Z",
      locked_by: `${RUN}:active-worker`,
      locked_until: "2026-05-21T22:25:01.000Z",
    };
    await enqueueRuntimeEffect(inFlight);

    await expect(recoverRuntimeEffect(inFlight.effect_id, {
      operation: "dead_letter",
      actor: "kakashi",
      reason: "should not override worker",
      now: "2026-05-21T22:24:02.000Z",
    })).rejects.toMatchObject({
      code: "RUNTIME_EFFECT_RECOVERY_ACTIVE_CLAIM",
      status: 409,
    });
  });

  test("admin API lists, inspects, and retries effects; unauthenticated callers are rejected", async () => {
    const record = recoveryRecord("api-dead-letter-retry", "dead_letter");
    await enqueueRuntimeEffect(record);

    const denied = await app.fetch(new Request("http://localhost/runtime-effects", { method: "GET" }));
    expect(denied.status).toBe(403);

    const listRes = await app.fetch(new Request("http://localhost/runtime-effects?status=dead_letter&limit=100", {
      headers: adminHeaders(),
    }));
    expect(listRes.status).toBe(200);
    const listed = await listRes.json();
    expect(listed.effects.some((effect: any) => effect.effect_id === record.effect_id)).toBe(true);

    const showRes = await app.fetch(new Request(`http://localhost/runtime-effects/${record.effect_id}`, {
      headers: adminHeaders(),
    }));
    expect(showRes.status).toBe(200);
    await expect(showRes.json()).resolves.toMatchObject({ ok: true, effect: { effect_id: record.effect_id, status: "dead_letter" } });

    const retryRes = await app.fetch(new Request(`http://localhost/runtime-effects/${record.effect_id}/retry`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ actor: "kakashi", reason: "api recovery test", now: "2026-05-21T22:25:00.000Z" }),
    }));
    expect(retryRes.status).toBe(200);
    await expect(retryRes.json()).resolves.toMatchObject({
      ok: true,
      receipt: {
        operation: "retry",
        from_status: "dead_letter",
        to_status: "pending",
        terminal_override: true,
      },
    });

    await expect(getRuntimeEffect(runtimeEffectIdFromIdempotencyKey(`${RUN}:api-dead-letter-retry`))).resolves.toMatchObject({
      status: "pending",
      attempts: 0,
    });
  });
});
