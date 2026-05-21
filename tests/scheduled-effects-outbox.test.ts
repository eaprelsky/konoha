import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  activeTasks,
  cancelCron,
  cancelSubscriptionsByInstance,
  createSubscriptionProgrammatic,
  enqueueSubscriptionCreateEffect,
  handleSubscriptionRuntimeEffect,
  subscriptionCancelIdempotencyKey,
  subscriptionCreateIdempotencyKey,
  subscriptionOutboxHooks,
  SUBSCRIPTIONS_KEY,
} from "../src/events/subscriptions";
import type { Subscription } from "../src/events/types";
import {
  createReminder,
  deleteReminder,
  enqueueReminderScheduleEffect,
  handleReminderScheduleEffect,
  reminderScheduleIdempotencyKey,
  reminderScheduleOutboxHooks,
} from "../src/runtime/reminders";
import {
  getRuntimeEffect,
  runtimeEffectIdFromIdempotencyKey,
} from "../src/runtime-effect-outbox";
import { processRuntimeEffectOutboxOnceWithHandlers } from "../src/runtime/workitem-dispatch-outbox";
import { redis } from "../src/redis";

const RUN = `scheduled-effects-outbox-${Date.now()}`;
const subscriptions = new Set<string>();
const reminders = new Set<string>();

const originalScheduleSubscriptionResources = subscriptionOutboxHooks.scheduleSubscriptionResources;
const originalScheduleReminderJob = reminderScheduleOutboxHooks.scheduleReminderJob;

function stopTrackedCronTasks(): void {
  for (const id of subscriptions) cancelCron(id);
  for (const id of [...activeTasks.keys()]) {
    if (id.includes(RUN)) cancelCron(id);
  }
}

beforeEach(() => {
  stopTrackedCronTasks();
  subscriptionOutboxHooks.scheduleSubscriptionResources = originalScheduleSubscriptionResources;
  reminderScheduleOutboxHooks.scheduleReminderJob = originalScheduleReminderJob;
});

afterAll(async () => {
  stopTrackedCronTasks();
  await Promise.all([...subscriptions].map(id => redis.hdel(SUBSCRIPTIONS_KEY, id).catch(() => 0)));
  await Promise.all([...reminders].map(id => deleteReminder(id).catch(() => {})));
  subscriptionOutboxHooks.scheduleSubscriptionResources = originalScheduleSubscriptionResources;
  reminderScheduleOutboxHooks.scheduleReminderJob = originalScheduleReminderJob;
});

describe("scheduled runtime effects outbox", () => {
  test("programmatic timer subscriptions enqueue durable activation before scheduling resources", async () => {
    const result = await createSubscriptionProgrammatic({
      event_id: "timer-start",
      event_label: "Timer Start",
      process_id: `${RUN}:workflow-subscription`,
      process_name: "Scheduled outbox workflow",
      instance_id: `${RUN}:case-subscription`,
      trigger: { kind: "timer", cron: "* * * * *" },
    });
    subscriptions.add(result.subscription_id);

    expect(result).toMatchObject({ status: "active", mode: "auto" });
    expect(activeTasks.has(result.subscription_id)).toBe(false);

    const idempotencyKey = subscriptionCreateIdempotencyKey(result.subscription_id);
    await expect(getRuntimeEffect(runtimeEffectIdFromIdempotencyKey(idempotencyKey))).resolves.toMatchObject({
      kind: "subscription.create",
      idempotency_key: idempotencyKey,
      status: "pending",
      links: {
        workflow_id: `${RUN}:workflow-subscription`,
        case_id: `${RUN}:case-subscription`,
        subscription_id: result.subscription_id,
        event_id: "timer-start",
      },
      payload: {
        operation: "activate",
        subscription_id: result.subscription_id,
        trigger_kind: "timer",
        mode: "auto",
      },
    });

    const effect = await getRuntimeEffect(runtimeEffectIdFromIdempotencyKey(idempotencyKey));
    expect(effect).not.toBeNull();
    const handled = await handleSubscriptionRuntimeEffect(effect!);
    expect(handled.receipt?.data).toMatchObject({
      operation: "activate",
      subscription_id: result.subscription_id,
      scheduled: true,
      resource: "cron",
    });
    expect(activeTasks.has(result.subscription_id)).toBe(true);
  });

  test("manual or unsupported subscriptions keep direct no-resource semantics", async () => {
    const result = await createSubscriptionProgrammatic({
      event_id: "manual-wait",
      event_label: "Manual Wait",
      process_id: `${RUN}:workflow-manual`,
      instance_id: `${RUN}:case-manual`,
      trigger: { kind: "manual", role: "reviewer" } as any,
    });
    subscriptions.add(result.subscription_id);

    expect(result).toMatchObject({ status: "active", mode: "manual" });
    const idempotencyKey = subscriptionCreateIdempotencyKey(result.subscription_id);
    await expect(getRuntimeEffect(runtimeEffectIdFromIdempotencyKey(idempotencyKey))).resolves.toBeNull();
  });

  test("stale subscription.create effect does not resurrect scheduler resources", async () => {
    const result = await createSubscriptionProgrammatic({
      event_id: "timer-stale",
      event_label: "Timer Stale",
      process_id: `${RUN}:workflow-stale`,
      instance_id: `${RUN}:case-stale`,
      trigger: { kind: "timer", cron: "* * * * *" },
    });
    subscriptions.add(result.subscription_id);

    const idempotencyKey = subscriptionCreateIdempotencyKey(result.subscription_id);
    const effect = await getRuntimeEffect(runtimeEffectIdFromIdempotencyKey(idempotencyKey));
    expect(effect).not.toBeNull();

    await redis.hdel(SUBSCRIPTIONS_KEY, result.subscription_id);
    const handled = await handleSubscriptionRuntimeEffect(effect!);
    expect(handled.receipt?.data).toMatchObject({
      operation: "activate",
      subscription_id: result.subscription_id,
      scheduled: false,
      resource: "none",
      reason: "subscription_missing",
    });
    expect(activeTasks.has(result.subscription_id)).toBe(false);
  });

  test("subscription activation retries and dead-letters through the shared worker", async () => {
    const sub: Subscription = {
      id: `${RUN}:sub-retry`,
      event_id: "timer-retry",
      process_id: `${RUN}:workflow-retry`,
      instance_id: `${RUN}:case-retry`,
      trigger: { kind: "timer", cron: "* * * * *" },
      status: "active",
      mode: "auto",
      subscribed_at: "2000-01-01T00:00:00.000Z",
      fire_count: 0,
    };
    subscriptions.add(sub.id);
    await redis.hset(SUBSCRIPTIONS_KEY, sub.id, JSON.stringify(sub));
    const enqueued = await enqueueSubscriptionCreateEffect(
      sub,
      "2000-01-01T00:00:00.000Z",
      { max_attempts: 2, dead_letter_after_attempts: 2, backoff: "fixed", retry_delays_ms: [0] },
    );

    subscriptionOutboxHooks.scheduleSubscriptionResources = async () => {
      const error = new Error("scheduler unavailable") as Error & { code: string; retryable: boolean };
      error.code = "SUBSCRIPTION_SCHEDULER_UNAVAILABLE";
      error.retryable = true;
      throw error;
    };

    const retry = await processRuntimeEffectOutboxOnceWithHandlers({
      worker_id: "subscription-worker",
      now: "2000-01-01T00:00:01.000Z",
      batch_size: 100,
    });
    expect(retry).toMatchObject({
      outcome: "retry",
      final_record: {
        effect_id: enqueued.record.effect_id,
        status: "retry",
        attempts: 1,
        error: { code: "SUBSCRIPTION_SCHEDULER_UNAVAILABLE", retryable: true },
      },
    });

    const deadLetter = await processRuntimeEffectOutboxOnceWithHandlers({
      worker_id: "subscription-worker",
      now: "2000-01-01T00:00:02.000Z",
      batch_size: 100,
    });
    expect(deadLetter).toMatchObject({
      outcome: "dead_letter",
      final_record: {
        effect_id: enqueued.record.effect_id,
        status: "dead_letter",
        attempts: 2,
        error: { code: "SUBSCRIPTION_SCHEDULER_UNAVAILABLE", retryable: false },
      },
    });
  });

  test("subscription cancellation enqueues resource cleanup with stable correlation", async () => {
    const result = await createSubscriptionProgrammatic({
      event_id: "timer-cancel",
      event_label: "Timer Cancel",
      process_id: `${RUN}:workflow-cancel`,
      instance_id: `${RUN}:case-cancel`,
      trigger: { kind: "timer", cron: "* * * * *" },
    });
    subscriptions.add(result.subscription_id);

    const createEffect = await getRuntimeEffect(runtimeEffectIdFromIdempotencyKey(subscriptionCreateIdempotencyKey(result.subscription_id)));
    expect(createEffect).not.toBeNull();
    await handleSubscriptionRuntimeEffect(createEffect!);
    expect(activeTasks.has(result.subscription_id)).toBe(true);

    await expect(cancelSubscriptionsByInstance(`${RUN}:case-cancel`)).resolves.toBe(1);
    expect(activeTasks.has(result.subscription_id)).toBe(true);

    const cancelKey = subscriptionCancelIdempotencyKey(result.subscription_id, "instance-cancel");
    const cancelEffect = await getRuntimeEffect(runtimeEffectIdFromIdempotencyKey(cancelKey));
    expect(cancelEffect).toMatchObject({
      kind: "subscription.cancel",
      idempotency_key: cancelKey,
      status: "pending",
      links: {
        workflow_id: `${RUN}:workflow-cancel`,
        case_id: `${RUN}:case-cancel`,
        subscription_id: result.subscription_id,
        event_id: "timer-cancel",
      },
      payload: {
        operation: "cancel_resources",
        subscription_id: result.subscription_id,
        reason: "instance-cancel",
      },
    });

    const handled = await handleSubscriptionRuntimeEffect(cancelEffect!);
    expect(handled.receipt?.data).toMatchObject({
      operation: "cancel_resources",
      subscription_id: result.subscription_id,
      reason: "instance-cancel",
    });
    expect(activeTasks.has(result.subscription_id)).toBe(false);
  });

  test("reminder creation enqueues durable scheduling with duplicate idempotency", async () => {
    const scheduledCalls: string[] = [];
    const reminder = await createReminder({
      type: "process-bound",
      recipient: "reviewer",
      message: "Review pending item",
      scheduled_at: new Date(Date.now() + 60_000).toISOString(),
      channel: "gui",
      case_id: `${RUN}:case-reminder`,
      process_id: `${RUN}:workflow-reminder`,
      element_id: "review",
      work_item_id: `${RUN}:wi-reminder`,
    });
    reminders.add(reminder.reminder_id);

    reminderScheduleOutboxHooks.scheduleReminderJob = async r => {
      scheduledCalls.push(r.reminder_id);
    };

    const idempotencyKey = reminderScheduleIdempotencyKey(reminder.reminder_id);
    const duplicate = await enqueueReminderScheduleEffect(reminder);
    expect(duplicate.duplicate).toBe(true);
    await expect(getRuntimeEffect(runtimeEffectIdFromIdempotencyKey(idempotencyKey))).resolves.toMatchObject({
      kind: "reminder.schedule",
      idempotency_key: idempotencyKey,
      status: "pending",
      links: {
        workflow_id: `${RUN}:workflow-reminder`,
        case_id: `${RUN}:case-reminder`,
        work_item_id: `${RUN}:wi-reminder`,
        event_id: "review",
        action_type: "reminder.schedule",
        action_trace_id: reminder.reminder_id,
      },
      payload: {
        operation: "schedule",
        reminder_id: reminder.reminder_id,
        status: "pending",
        channel: "gui",
      },
    });

    const effect = await getRuntimeEffect(runtimeEffectIdFromIdempotencyKey(idempotencyKey));
    expect(effect).not.toBeNull();
    const handled = await handleReminderScheduleEffect(effect!);
    expect(handled.receipt?.data).toMatchObject({
      reminder_id: reminder.reminder_id,
      scheduled: true,
      channel: "gui",
    });
    expect(scheduledCalls).toEqual([reminder.reminder_id]);
  });

  test("subscription handler rejects unsupported effect kinds without retry", async () => {
    await expect(handleSubscriptionRuntimeEffect({
      schema_version: 1,
      effect_id: `${RUN}:bad-kind`,
      kind: "reminder.schedule",
      idempotency_key: `${RUN}:bad-kind`,
      payload: {},
      status: "pending",
      attempts: 0,
      retry_policy: { max_attempts: 1, backoff: "fixed", retry_delays_ms: [0], dead_letter_after_attempts: 1 },
      links: { action_trace_id: `${RUN}:bad-kind` },
      created_at: "2000-01-01T00:00:00.000Z",
      updated_at: "2000-01-01T00:00:00.000Z",
    } as any)).rejects.toMatchObject({
      code: "RUNTIME_EFFECT_KIND_UNSUPPORTED",
      retryable: false,
    });
  });
});
