/**
 * events/subscriptions.ts — In-memory subscription state and lifecycle management.
 * Handles cron scheduling, message/condition listeners, delay_after triggers,
 * event firing, and programmatic subscription API.
 */

import { randomUUID } from "crypto";
import * as nodeCron from "node-cron";
import { CronExpressionParser } from "cron-parser";
import { redis, sendMessage } from "../redis";
import type { DataAdapter, ListenerHandle } from "../adapters/data-adapter";
import { listenerRegistry } from "../adapters/data-adapter";
import { bitrixAdapter } from "../adapters/bitrix";
import { githubAdapter } from "../adapters/github";
import { telegramBotAdapter } from "../adapters/telegram-bot";
import { trackerAdapter } from "../adapters/tracker";
import { parseBdDuration } from "../work-calendar";
import { createLogger, silentCatch } from "../logger";
import type { Subscription, TriggerDef, TimerTrigger, MessageTrigger, ConditionTrigger, DelayAfterTrigger } from "./types";
import { delayQueue } from "./queue";
import {
  parseDurationMs,
  resolveDelayMs,
  computeNextFireAt,
  evalCondition,
  withRetry,
  recordAdapterSuccess,
  recordAdapterError,
  getAdapterRateLimiter,
} from "./utils";

const log = createLogger("event-manager");

export const SUBSCRIPTIONS_KEY = "event-manager:subscriptions";
export const HISTORY_KEY = "event-manager:history";
const HISTORY_MAX_ENTRIES = 500;
const SENDER = "event-manager";

// ── In-memory cron task registry ─────────────────────────────────────────────

export const activeTasks = new Map<string, nodeCron.ScheduledTask>();

// ── DataAdapter registry ──────────────────────────────────────────────────────

export const dataAdapters = new Map<string, DataAdapter>([
  ["bitrix", bitrixAdapter],
  ["github", githubAdapter],
  ["telegram", telegramBotAdapter],
  ["tracker", trackerAdapter],
]);

// Maps subscriptionId → ListenerHandle (for message triggers)
export const activeListeners = new Map<string, ListenerHandle>();

// Maps subscriptionId → condition poll timer
export const conditionTimers = new Map<string, ReturnType<typeof setInterval>>();

// ── Publish event_fired on the bus ────────────────────────────────────────────

export async function publishEventFired(
  sub: Subscription,
  sourceData: Record<string, unknown> = {},
): Promise<void> {
  const firedAt = new Date().toISOString();

  const payload = {
    event_id: sub.event_id,
    process_id: sub.process_id,
    instance_id: sub.instance_id,
    trigger_kind: sub.trigger.kind,
    fired_at: firedAt,
    source_data: sourceData,
    idempotency_key: `event-fired:${sub.id}:${firedAt}`,
  };

  await sendMessage({
    from: SENDER,
    to: "workflow-engine",
    type: "event_fired",
    text: JSON.stringify(payload),
  });

  try {
    const { handleEventFired } = await import("../runtime");
    await handleEventFired(payload);
  } catch (e: any) {
    log.error(`[event-manager] direct event_fired handling failed sub=${sub.id}: ${e.message}`);
  }

  // Persist last_fired_at and increment fire_count
  sub.last_fired_at = firedAt;
  sub.fire_count = (sub.fire_count ?? 0) + 1;
  // Update next_fire_at for repeating timers
  if (sub.trigger.kind === "timer") {
    sub.next_fire_at = computeNextFireAt(sub.trigger);
  }
  await redis.hset(SUBSCRIPTIONS_KEY, sub.id, JSON.stringify(sub));

  // Record to history (capped list via sorted set by timestamp)
  const historyEntry = JSON.stringify({
    subscription_id: sub.id,
    event_id: sub.event_id,
    event_label: sub.event_label,
    process_id: sub.process_id,
    process_name: sub.process_name,
    instance_id: sub.instance_id,
    trigger_kind: sub.trigger.kind,
    fired_at: firedAt,
    source_data: sourceData,
  });
  const score = Date.now();
  await redis.zadd(HISTORY_KEY, score, historyEntry);
  await redis.zremrangebyrank(HISTORY_KEY, 0, -(HISTORY_MAX_ENTRIES + 1));

  log.info(
    `[event-manager] event_fired sub=${sub.id} event_id=${sub.event_id} process_id=${sub.process_id} kind=${sub.trigger.kind}`,
  );
}

// ── Cron scheduling ───────────────────────────────────────────────────────────

export function scheduleCron(sub: Subscription): void {
  const trigger = sub.trigger as TimerTrigger;
  if (!trigger.cron) return;

  const existing = activeTasks.get(sub.id);
  if (existing) {
    existing.stop();
    activeTasks.delete(sub.id);
  }

  if (!nodeCron.validate(trigger.cron)) {
    log.warn(`[event-manager] invalid cron expr sub=${sub.id}: "${trigger.cron}"`);
    return;
  }

  const task = nodeCron.schedule(trigger.cron, async () => {
    try {
      await publishEventFired(sub, { cron: trigger.cron });
    } catch (e: any) {
      log.error(`[event-manager] cron fire error sub=${sub.id}: ${e.message}`);
    }
  });

  activeTasks.set(sub.id, task);
  log.info(`[event-manager] scheduled cron sub=${sub.id} expr="${trigger.cron}"`);
}

export function cancelCron(id: string): void {
  const task = activeTasks.get(id);
  if (task) {
    task.stop();
    activeTasks.delete(id);
    log.info(`[event-manager] cancelled cron sub=${id}`);
  }
}

// ── Missed firing detection ───────────────────────────────────────────────────

export async function checkMissedFirings(sub: Subscription): Promise<void> {
  const trigger = sub.trigger as TimerTrigger;
  if (trigger.kind !== "timer" || !trigger.cron) return;
  if (!sub.last_fired_at) return;

  const from = new Date(sub.last_fired_at);
  const now = new Date();

  if (from >= now) return;

  try {
    const interval = CronExpressionParser.parse(trigger.cron, {
      currentDate: from,
      endDate: now,
    });

    const missed: Date[] = [];
    while (true) {
      try {
        const next = interval.next();
        missed.push(next.toDate());
      } catch {
        break;
      }
    }

    if (missed.length > 0) {
      log.info(
        `[event-manager] ${missed.length} missed firing(s) for sub=${sub.id}, publishing catch-up events`,
      );
      for (const missedAt of missed) {
        await publishEventFired(sub, {
          cron: trigger.cron,
          missed: true,
          missed_at: missedAt.toISOString(),
        });
      }
    }
  } catch (e: any) {
    log.warn(`[event-manager] missed firing check error sub=${sub.id}: ${e.message}`);
  }
}

// ── Activate delay_after trigger ─────────────────────────────────────────────

export async function activateDelayAfterTrigger(sub: Subscription): Promise<void> {
  const trigger = sub.trigger as DelayAfterTrigger;
  let delayMs: number;
  try {
    delayMs = await resolveDelayMs(trigger.duration, sub.subscribed_at || new Date().toISOString());
  } catch (e: any) {
    log.warn(`[event-manager] invalid delay_after duration sub=${sub.id}: ${e.message}`);
    return;
  }

  const existingJob = await delayQueue.getJob(sub.id).catch(() => null);
  if (existingJob) {
    log.info(`[event-manager] delay_after job already queued sub=${sub.id}`);
    return;
  }

  await delayQueue.add("fire", { subscription_id: sub.id }, {
    jobId: sub.id,
    delay: delayMs,
    removeOnComplete: true,
    removeOnFail: { count: 5 },
  });

  log.info(`[event-manager] delay_after queued sub=${sub.id} delay=${delayMs}ms`);
}

// ── Activate message trigger ──────────────────────────────────────────────────

export async function activateMessageTrigger(sub: Subscription): Promise<void> {
  const trigger = sub.trigger as MessageTrigger;
  const adapter = dataAdapters.get(trigger.source);
  if (!adapter) {
    log.warn(`[event-manager] no DataAdapter for source="${trigger.source}" sub=${sub.id} → manual mode`);
    return;
  }

  const existing = activeListeners.get(sub.id);
  if (existing) {
    await adapter.removeListener(existing).catch(silentCatch("remove subscription listener"));
    activeListeners.delete(sub.id);
  }

  try {
    const handle = await withRetry(
      () => adapter.setupListener(trigger.filter, async (payload) => {
        await publishEventFired(sub, { payload }).catch(e =>
          log.error(`[event-manager] message fire error sub=${sub.id}: ${e.message}`),
        );
      }),
      `setupListener sub=${sub.id} source=${trigger.source}`,
    );
    activeListeners.set(sub.id, handle);
    log.info(`[event-manager] message listener activated sub=${sub.id} source=${trigger.source}`);
  } catch (e: any) {
    log.error(`[event-manager] message listener setup exhausted retries sub=${sub.id}: ${e.message} → switching to manual mode`);
    sub.mode = "manual";
    await redis.hset(SUBSCRIPTIONS_KEY, sub.id, JSON.stringify(sub));
  }
}

// ── Activate condition trigger ─────────────────────────────────────────────────

export async function activateConditionTrigger(sub: Subscription): Promise<void> {
  const trigger = sub.trigger as ConditionTrigger;
  const adapter = dataAdapters.get(trigger.data_source);
  if (!adapter) {
    log.warn(`[event-manager] no DataAdapter for data_source="${trigger.data_source}" sub=${sub.id} → manual mode`);
    return;
  }

  const existingTimer = conditionTimers.get(sub.id);
  if (existingTimer) {
    clearInterval(existingTimer);
    conditionTimers.delete(sub.id);
  }

  let pollMs: number;
  try {
    pollMs = parseDurationMs(trigger.poll_interval);
  } catch {
    pollMs = 30_000;
    log.warn(`[event-manager] invalid poll_interval sub=${sub.id}, defaulting to 30s`);
  }

  const rateLimiter = getAdapterRateLimiter(trigger.data_source);

  const timer = setInterval(async () => {
    try {
      await rateLimiter.acquire(trigger.data_source);
      const value = await withRetry(
        () => adapter.executeQuery({
          entity: trigger.query.entity,
          filter: trigger.query.filter,
          metric: trigger.query.metric as any,
          sum_field: trigger.query.sum_field,
        }),
        `executeQuery sub=${sub.id} source=${trigger.data_source}`,
      );

      recordAdapterSuccess(trigger.data_source);
      const pollAt = new Date().toISOString();
      const freshPoll = await redis.hget(SUBSCRIPTIONS_KEY, sub.id);
      if (freshPoll) {
        const sp: Subscription = JSON.parse(freshPoll);
        sp.last_poll_at = pollAt;
        sp.last_poll_result = value;
        await redis.hset(SUBSCRIPTIONS_KEY, sub.id, JSON.stringify(sp));
        Object.assign(sub, sp);
      }

      if (evalCondition(value, trigger.operator, trigger.threshold)) {
        await publishEventFired(sub, {
          data_source: trigger.data_source,
          value,
          operator: trigger.operator,
          threshold: trigger.threshold,
        });

        sub.status = "cancelled";
        await redis.hset(SUBSCRIPTIONS_KEY, sub.id, JSON.stringify(sub));
        clearInterval(timer);
        conditionTimers.delete(sub.id);
        log.info(`[event-manager] condition matched and unsubscribed sub=${sub.id}`);
      }
    } catch (e: any) {
      recordAdapterError(trigger.data_source, e.message);
      log.error(`[event-manager] condition poll exhausted retries sub=${sub.id}: ${e.message} → switching to manual mode`);
      sub.mode = "manual";
      await redis.hset(SUBSCRIPTIONS_KEY, sub.id, JSON.stringify(sub));
      clearInterval(timer);
      conditionTimers.delete(sub.id);
    }
  }, pollMs);

  conditionTimers.set(sub.id, timer);
  log.info(`[event-manager] condition poller activated sub=${sub.id} source=${trigger.data_source} interval=${trigger.poll_interval}`);
}

// ── Cancel all active resources for a subscription ───────────────────────────

export async function cancelSubscriptionResources(sub: Subscription): Promise<void> {
  const { id, trigger } = sub;

  if (trigger.kind === "timer") {
    cancelCron(id);
  } else if (trigger.kind === "message") {
    const handle = activeListeners.get(id);
    if (handle) {
      const adapter = dataAdapters.get((trigger as MessageTrigger).source);
      await adapter?.removeListener(handle).catch(silentCatch("remove listener on cancel"));
      activeListeners.delete(id);
    }
  } else if (trigger.kind === "condition") {
    const timer = conditionTimers.get(id);
    if (timer) {
      clearInterval(timer);
      conditionTimers.delete(id);
    }
  } else if (trigger.kind === "delay_after") {
    const job = await delayQueue.getJob(id).catch(() => null);
    await job?.remove().catch(silentCatch("remove delay job on cancel"));
    log.info(`[event-manager] delay_after job removed sub=${id}`);
  }
}

// ── Restore delay_after subscription ─────────────────────────────────────────

export async function restoreDelayAfterSub(sub: Subscription): Promise<void> {
  const trigger = sub.trigger as DelayAfterTrigger;

  const existingJob = await delayQueue.getJob(sub.id).catch(() => null);
  if (existingJob) {
    log.info(`[event-manager] delay_after job still queued in BullMQ sub=${sub.id}`);
    return;
  }

  let durationMs: number;
  try {
    durationMs = await resolveDelayMs(trigger.duration, sub.subscribed_at || new Date().toISOString());
  } catch (e: any) {
    log.warn(`[event-manager] delay_after restore: invalid duration sub=${sub.id}: ${e.message}`);
    return;
  }

  const isBd = parseBdDuration(trigger.duration);
  const remainingMs = isBd ? durationMs : new Date(sub.subscribed_at).getTime() + durationMs - Date.now();

  if (remainingMs <= 0) {
    log.info(`[event-manager] delay_after past due on restore sub=${sub.id} — firing now`);
    await publishEventFired(sub, { duration: trigger.duration, ref_event: trigger.ref_event ?? null, missed: true });
    sub.status = "cancelled";
    await redis.hset(SUBSCRIPTIONS_KEY, sub.id, JSON.stringify(sub));
  } else {
    await delayQueue.add("fire", { subscription_id: sub.id }, {
      jobId: sub.id,
      delay: remainingMs,
      removeOnComplete: true,
      removeOnFail: { count: 5 },
    });
    log.info(`[event-manager] delay_after re-queued sub=${sub.id} remaining=${remainingMs}ms`);
  }
}

// ── Restore subscriptions on startup ─────────────────────────────────────────

export async function restoreSubscriptions(): Promise<void> {
  const all = await redis.hgetall(SUBSCRIPTIONS_KEY).catch(() => ({}));
  const subs = Object.values(all).map(v => JSON.parse(v) as Subscription);
  const active = subs.filter(s => s.status === "active");

  log.info(`[event-manager] restoring ${active.length} active subscription(s)`);

  for (const sub of active) {
    if (sub.trigger.kind === "timer") {
      await checkMissedFirings(sub).catch(e =>
        log.error(`[event-manager] missed firing check failed sub=${sub.id}: ${e.message}`),
      );
      const fresh = await redis.hget(SUBSCRIPTIONS_KEY, sub.id);
      const freshSub: Subscription = fresh ? JSON.parse(fresh) : sub;
      scheduleCron(freshSub);
    } else if (sub.trigger.kind === "message") {
      await activateMessageTrigger(sub).catch(e =>
        log.error(`[event-manager] message listener restore failed sub=${sub.id}: ${e.message}`),
      );
    } else if (sub.trigger.kind === "condition") {
      await activateConditionTrigger(sub).catch(e =>
        log.error(`[event-manager] condition poller restore failed sub=${sub.id}: ${e.message}`),
      );
    } else if (sub.trigger.kind === "delay_after") {
      await restoreDelayAfterSub(sub).catch(e =>
        log.error(`[event-manager] delay_after restore failed sub=${sub.id}: ${e.message}`),
      );
    } else {
      log.info(`[event-manager] sub=${sub.id} kind=${sub.trigger.kind} → manual mode`);
    }
  }

  log.info(`[event-manager] restored ${activeTasks.size} cron job(s), ${activeListeners.size} listener(s), ${conditionTimers.size} condition poller(s)`);
}

// ── Programmatic API (used by workflow engine in runtime.ts) ─────────────────

/**
 * Create a subscription programmatically (no HTTP round-trip).
 * Used by the workflow engine when starting instances or advancing to intermediate events.
 */
export async function createSubscriptionProgrammatic(params: {
  event_id: string;
  event_label?: string;
  process_id: string;
  process_name?: string;
  instance_id: string;
  trigger: TriggerDef;
}): Promise<{ subscription_id: string; status: string; mode: "auto" | "manual" }> {
  const trigger = params.trigger;
  let mode: "auto" | "manual" = "manual";

  if (trigger.kind === "timer") {
    const cronExpr = (trigger as TimerTrigger).cron;
    if (cronExpr && nodeCron.validate(cronExpr)) mode = "auto";
  } else if (trigger.kind === "message") {
    const mt = trigger as MessageTrigger;
    if (mt.source && dataAdapters.has(mt.source)) mode = "auto";
  } else if (trigger.kind === "condition") {
    const ct = trigger as ConditionTrigger;
    if (ct.data_source && dataAdapters.has(ct.data_source)) mode = "auto";
  } else if (trigger.kind === "delay_after") {
    const dt = trigger as DelayAfterTrigger;
    if (parseBdDuration(dt.duration)) { mode = "auto"; }
    else { try { parseDurationMs(dt.duration); mode = "auto"; } catch {} }
  }

  // Dedup: cancel any existing active subscriptions for the same (process_id, event_id, instance_id).
  {
    const all = await redis.hgetall(SUBSCRIPTIONS_KEY).catch(() => ({} as Record<string, string>));
    for (const raw of Object.values(all)) {
      let existing: Subscription;
      try { existing = JSON.parse(raw); } catch { continue; }
      if (
        existing.status === "active" &&
        existing.process_id === params.process_id &&
        existing.event_id === params.event_id &&
        existing.instance_id === params.instance_id
      ) {
        existing.status = "cancelled";
        await redis.hset(SUBSCRIPTIONS_KEY, existing.id, JSON.stringify(existing));
        await cancelSubscriptionResources(existing).catch(silentCatch("cancel subscription resources"));
        log.info(`[event-manager] dedup: cancelled stale sub=${existing.id} for process_id=${params.process_id} event_id=${params.event_id}`);
      }
    }
  }

  const now2 = new Date().toISOString();
  const sub: Subscription = {
    id: `sub_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    event_id: params.event_id,
    event_label: params.event_label,
    process_id: params.process_id,
    process_name: params.process_name,
    instance_id: params.instance_id,
    trigger,
    status: "active",
    mode,
    subscribed_at: now2,
    fire_count: 0,
    next_fire_at: computeNextFireAt(trigger, now2),
  };

  await redis.hset(SUBSCRIPTIONS_KEY, sub.id, JSON.stringify(sub));

  if (mode === "auto") {
    if (trigger.kind === "timer") {
      scheduleCron(sub);
    } else if (trigger.kind === "message") {
      await activateMessageTrigger(sub).catch(e =>
        log.error(`[event-manager] message listener setup failed sub=${sub.id}: ${e.message}`),
      );
    } else if (trigger.kind === "condition") {
      await activateConditionTrigger(sub).catch(e =>
        log.error(`[event-manager] condition poller setup failed sub=${sub.id}: ${e.message}`),
      );
    } else if (trigger.kind === "delay_after") {
      await activateDelayAfterTrigger(sub).catch(e =>
        log.error(`[event-manager] delay_after queue failed sub=${sub.id}: ${e.message}`),
      );
    }
  }

  log.info(
    `[event-manager] subscribed (programmatic) id=${sub.id} event_id=${sub.event_id} process_id=${sub.process_id} kind=${trigger.kind} mode=${mode}`,
  );

  return { subscription_id: sub.id, status: sub.status, mode };
}

/**
 * Cancel all active subscriptions for a given instance_id.
 * Called by the workflow engine when an instance ends (done or error).
 * Returns the number of subscriptions cancelled.
 */
export async function cancelSubscriptionsByInstance(instance_id: string): Promise<number> {
  const all = await redis.hgetall(SUBSCRIPTIONS_KEY).catch(() => ({} as Record<string, string>));
  const subs = Object.values(all).map(v => JSON.parse(v) as Subscription);
  const matching = subs.filter(s => s.instance_id === instance_id && s.status === "active");

  for (const sub of matching) {
    sub.status = "cancelled";
    await redis.hset(SUBSCRIPTIONS_KEY, sub.id, JSON.stringify(sub));
    await cancelSubscriptionResources(sub).catch(e =>
      log.warn(`[event-manager] cancel resources error sub=${sub.id}: ${e.message}`),
    );
    log.info(`[event-manager] cancelled sub=${sub.id} for instance_id=${instance_id}`);
  }

  return matching.length;
}

/**
 * Cancel all active subscriptions matching both process_id AND instance_id.
 * Used during workflow republish to clean up stale start-event subs
 * before creating fresh ones (issue #490).
 * Returns the number of subscriptions cancelled.
 */
export async function cancelSubscriptionsByProcessAndInstance(
  process_id: string,
  instance_id: string,
): Promise<number> {
  const all = await redis.hgetall(SUBSCRIPTIONS_KEY).catch(() => ({} as Record<string, string>));
  const subs = Object.values(all).map(v => JSON.parse(v) as Subscription);
  const matching = subs.filter(
    s => s.process_id === process_id && s.instance_id === instance_id && s.status === "active",
  );

  for (const sub of matching) {
    sub.status = "cancelled";
    await redis.hset(SUBSCRIPTIONS_KEY, sub.id, JSON.stringify(sub));
    await cancelSubscriptionResources(sub).catch(e =>
      log.warn(`[event-manager] cancel resources error sub=${sub.id}: ${e.message}`),
    );
    log.info(
      `[event-manager] cancelled stale start-event sub=${sub.id} process_id=${process_id} event_id=${sub.event_id}`,
    );
  }

  return matching.length;
}
