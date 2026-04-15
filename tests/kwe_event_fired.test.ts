/**
 * kwe_event_fired.test.ts
 *
 * Tests for issue #229: event_fired integration and subscription cleanup.
 *
 * Key test (required per Yegor):
 *   create 3 subscriptions for an instance → end instance → verify 0 active subscriptions.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { randomUUID } from "crypto";
import { redis } from "../src/redis";
import {
  cancelSubscriptionsByInstance,
  cancelSubscriptionsByProcessAndInstance,
  createSubscriptionProgrammatic,
} from "../src/event-manager";

const SUBSCRIPTIONS_KEY = "event-manager:subscriptions";

describe("cancelSubscriptionsByInstance", () => {
  const instanceId = `test-instance-${randomUUID()}`;

  // Clean up test subscriptions after each test
  beforeEach(async () => {
    const all = await redis.hgetall(SUBSCRIPTIONS_KEY).catch(() => ({}));
    for (const [k, v] of Object.entries(all)) {
      const sub = JSON.parse(v) as { instance_id: string };
      if (sub.instance_id === instanceId) {
        await redis.hdel(SUBSCRIPTIONS_KEY, k);
      }
    }
  });

  it("should cancel all 3 active subscriptions for an instance", async () => {
    // Arrange: create 3 subscriptions with same instance_id
    // Use manual mode (kind="manual") to avoid triggering real adapters
    const sub1 = await createSubscriptionProgrammatic({
      event_id: "evt_001",
      process_id: "test-proc",
      instance_id: instanceId,
      trigger: { kind: "manual", action: "complete", role: "user" } as any,
    });
    const sub2 = await createSubscriptionProgrammatic({
      event_id: "evt_002",
      process_id: "test-proc",
      instance_id: instanceId,
      trigger: { kind: "manual", action: "approve", role: "manager" } as any,
    });
    const sub3 = await createSubscriptionProgrammatic({
      event_id: "evt_003",
      process_id: "test-proc",
      instance_id: instanceId,
      trigger: { kind: "manual", action: "submit", role: "analyst" } as any,
    });

    // Verify all 3 are active
    const before = await redis.hgetall(SUBSCRIPTIONS_KEY);
    const activeBefore = Object.values(before)
      .map(v => JSON.parse(v))
      .filter(s => s.instance_id === instanceId && s.status === "active");
    expect(activeBefore.length).toBe(3);

    // Act: cancel all subscriptions for this instance
    const cancelledCount = await cancelSubscriptionsByInstance(instanceId);
    expect(cancelledCount).toBe(3);

    // Assert: 0 active subscriptions for this instance in Redis
    const after = await redis.hgetall(SUBSCRIPTIONS_KEY);
    const activeAfter = Object.values(after)
      .map(v => JSON.parse(v))
      .filter(s => s.instance_id === instanceId && s.status === "active");
    expect(activeAfter.length).toBe(0);

    // Subscriptions still exist but as "cancelled"
    const cancelledAfter = Object.values(after)
      .map(v => JSON.parse(v))
      .filter(s => s.instance_id === instanceId && s.status === "cancelled");
    expect(cancelledAfter.length).toBe(3);
  });

  it("should return 0 when no active subscriptions exist for instance", async () => {
    const count = await cancelSubscriptionsByInstance("nonexistent-instance-id");
    expect(count).toBe(0);
  });

  it("should not affect subscriptions for other instances", async () => {
    const otherInstanceId = `other-instance-${randomUUID()}`;

    // Create subscription for the instance under test
    await createSubscriptionProgrammatic({
      event_id: "evt_001",
      process_id: "test-proc",
      instance_id: instanceId,
      trigger: { kind: "manual", action: "complete", role: "user" } as any,
    });

    // Create subscription for another instance
    await createSubscriptionProgrammatic({
      event_id: "evt_100",
      process_id: "test-proc",
      instance_id: otherInstanceId,
      trigger: { kind: "manual", action: "complete", role: "user" } as any,
    });

    // Cancel only our instance
    await cancelSubscriptionsByInstance(instanceId);

    // Other instance's subscription should still be active
    const after = await redis.hgetall(SUBSCRIPTIONS_KEY);
    const otherActive = Object.values(after)
      .map(v => JSON.parse(v))
      .filter(s => s.instance_id === otherInstanceId && s.status === "active");
    expect(otherActive.length).toBe(1);

    // Clean up other instance
    await cancelSubscriptionsByInstance(otherInstanceId);
  });
});

describe("migrateTriggerKind (via getWorkflow)", () => {
  it("should migrate trigger.type='schedule' to kind='timer' on read", async () => {
    const workflowId = `test-migration-${randomUUID()}`;
    const legacyWorkflow = {
      id: workflowId,
      version: "1.0",
      name: "Migration Test",
      elements: [
        {
          id: "e_start",
          type: "event",
          label: "Каждый понедельник",
          trigger: { type: "schedule", cron: "0 9 * * 1" },
        },
        { id: "f1", type: "function", label: "Запустить задачу", role: "manager" },
        { id: "e_end", type: "event", label: "Задача запущена" },
      ],
      flow: [["e_start", "f1"], ["f1", "e_end"]],
    };

    // Save with legacy format directly to Redis
    await redis.set(`workflow:${workflowId}`, JSON.stringify(legacyWorkflow));
    await redis.sadd("konoha:workflow:index", workflowId);

    // Read through getWorkflow — should apply migration
    const { getWorkflow } = await import("../src/workflow-loader");
    const loaded = await getWorkflow(workflowId);

    expect(loaded).not.toBeNull();
    const startEl = loaded!.elements.find(e => e.id === "e_start");
    expect(startEl?.trigger?.kind).toBe("timer");
    expect(startEl?.trigger?.cron).toBe("0 9 * * 1");
    // Legacy `type` field should still be present (we don't delete it, just add `kind`)
    // but the codebase uses `kind` for routing

    // Cleanup
    await redis.del(`workflow:${workflowId}`);
    await redis.srem("konoha:workflow:index", workflowId);
  });

  it("should migrate trigger.type='telegram' to kind='message' with source='telegram'", async () => {
    const workflowId = `test-migration-tg-${randomUUID()}`;
    const legacyWorkflow = {
      id: workflowId,
      version: "1.0",
      name: "TG Migration Test",
      elements: [
        {
          id: "e_start",
          type: "event",
          label: "Входящее сообщение",
          trigger: { type: "telegram", chat_id: "-100123456" },
        },
        { id: "f1", type: "function", label: "Обработать", role: "bot" },
        { id: "e_end", type: "event", label: "Обработано" },
      ],
      flow: [["e_start", "f1"], ["f1", "e_end"]],
    };

    await redis.set(`workflow:${workflowId}`, JSON.stringify(legacyWorkflow));
    await redis.sadd("konoha:workflow:index", workflowId);

    const { getWorkflow } = await import("../src/workflow-loader");
    const loaded = await getWorkflow(workflowId);
    const startEl = loaded!.elements.find(e => e.id === "e_start");

    expect(startEl?.trigger?.kind).toBe("message");
    expect(startEl?.trigger?.source).toBe("telegram");
    expect((startEl?.trigger?.filter as any)?.chat_id).toBe("-100123456");

    await redis.del(`workflow:${workflowId}`);
    await redis.srem("konoha:workflow:index", workflowId);
  });
});

// ── Tests for cancelSubscriptionsByProcessAndInstance (issue #490) ─────────────

describe("cancelSubscriptionsByProcessAndInstance", () => {
  const processId = `test-proc-pi-${randomUUID()}`;
  const newInstance = `new`;

  beforeEach(async () => {
    const all = await redis.hgetall(SUBSCRIPTIONS_KEY).catch(() => ({}));
    for (const [k, v] of Object.entries(all)) {
      const sub = JSON.parse(v) as { process_id: string };
      if (sub.process_id === processId) {
        await redis.hdel(SUBSCRIPTIONS_KEY, k);
      }
    }
  });

  it("should cancel all active subs matching process_id + instance_id='new'", async () => {
    // Create 2 subs with instance_id="new" (deploy-time start event subs)
    await createSubscriptionProgrammatic({
      event_id: "start_evt_1",
      process_id: processId,
      instance_id: "new",
      trigger: { kind: "manual", action: "complete", role: "user" } as any,
    });
    await createSubscriptionProgrammatic({
      event_id: "start_evt_2",
      process_id: processId,
      instance_id: "new",
      trigger: { kind: "manual", action: "submit", role: "manager" } as any,
    });

    // Verify both are active
    const before = await redis.hgetall(SUBSCRIPTIONS_KEY);
    const activeBefore = Object.values(before)
      .map(v => JSON.parse(v))
      .filter(s => s.process_id === processId && s.instance_id === "new" && s.status === "active");
    expect(activeBefore.length).toBe(2);

    // Act: cancel by process+instance
    const count = await cancelSubscriptionsByProcessAndInstance(processId, "new");
    expect(count).toBe(2);

    // Assert: 0 active subs for this process+instance
    const after = await redis.hgetall(SUBSCRIPTIONS_KEY);
    const activeAfter = Object.values(after)
      .map(v => JSON.parse(v))
      .filter(s => s.process_id === processId && s.instance_id === "new" && s.status === "active");
    expect(activeAfter.length).toBe(0);
  });

  it("should not cancel subs with a different instance_id (running case)", async () => {
    // Create a "new" sub (deploy-time) and a running case sub
    await createSubscriptionProgrammatic({
      event_id: "start_evt",
      process_id: processId,
      instance_id: "new",
      trigger: { kind: "manual", action: "complete", role: "user" } as any,
    });
    await createSubscriptionProgrammatic({
      event_id: "intermediate_evt",
      process_id: processId,
      instance_id: "case-abc-123",
      trigger: { kind: "manual", action: "approve", role: "manager" } as any,
    });

    // Cancel only "new" subs
    const count = await cancelSubscriptionsByProcessAndInstance(processId, "new");
    expect(count).toBe(1);

    // The running case sub should still be active
    const after = await redis.hgetall(SUBSCRIPTIONS_KEY);
    const caseSub = Object.values(after)
      .map(v => JSON.parse(v))
      .find(s => s.instance_id === "case-abc-123");
    expect(caseSub?.status).toBe("active");
  });

  it("should return 0 when no matching subs exist", async () => {
    const count = await cancelSubscriptionsByProcessAndInstance("nonexistent-proc", "new");
    expect(count).toBe(0);
  });
});
