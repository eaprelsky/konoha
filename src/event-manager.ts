/**
 * event-manager.ts — Event Manager module.
 *
 * Stores subscriptions in Redis, creates cron jobs for timer triggers,
 * activates message/condition listeners via DataAdapters,
 * publishes event_fired messages on the Konoha bus on each firing.
 *
 * Endpoints:
 *   POST   /api/event-manager/subscribe
 *   DELETE /api/event-manager/subscribe/:id
 *   GET    /api/event-manager/subscriptions
 *   POST   /api/webhooks/bitrix   (Bitrix24 event push dispatch)
 */

import { randomUUID } from "crypto";
import * as nodeCron from "node-cron";
import { CronExpressionParser } from "cron-parser";
import { Queue, Worker } from "bullmq";
import { redis, sendMessage, REDIS_CONNECTION_OPTS } from "./redis";
import type { Hono, MiddlewareHandler } from "hono";
import type { HonoEnv } from "./types";
import type { DataAdapter, ListenerHandle } from "./adapters/data-adapter";
import { listenerRegistry } from "./adapters/data-adapter";
import { bitrixAdapter } from "./adapters/bitrix";
import { telegramBotAdapter } from "./adapters/telegram-bot";
import { trackerAdapter } from "./adapters/tracker";
import { parseBdDuration } from "./work-calendar";

const SUBSCRIPTIONS_KEY = "event-manager:subscriptions";
const HISTORY_KEY = "event-manager:history";
const HISTORY_MAX_ENTRIES = 500;
const SENDER = "event-manager";

// ── Adapter stats (in-memory) ─────────────────────────────────────────────────

interface AdapterStats {
  name: string;
  last_success_at?: string;
  last_error_at?: string;
  last_error?: string;
  error_count: number;
  active_listeners: number;
}

const adapterStats = new Map<string, AdapterStats>();

function getAdapterStats(name: string): AdapterStats {
  if (!adapterStats.has(name)) {
    adapterStats.set(name, { name, error_count: 0, active_listeners: 0 });
  }
  return adapterStats.get(name)!;
}

function recordAdapterSuccess(name: string): void {
  const s = getAdapterStats(name);
  s.last_success_at = new Date().toISOString();
}

function recordAdapterError(name: string, msg: string): void {
  const s = getAdapterStats(name);
  s.last_error_at = new Date().toISOString();
  s.last_error = msg;
  s.error_count++;
}

// ── Compute next fire time for timer triggers ─────────────────────────────────

function computeNextFireAt(trigger: TriggerDef, subscribedAt?: string): string | undefined {
  if (trigger.kind === "timer") {
    const t = trigger as TimerTrigger;
    if (t.cron) {
      try {
        const interval = CronExpressionParser.parse(t.cron, { currentDate: new Date() });
        return interval.next().toDate().toISOString();
      } catch { return undefined; }
    }
  }
  if (trigger.kind === "delay_after") {
    const t = trigger as DelayAfterTrigger;
    if (t.duration && subscribedAt) {
      try {
        // BD durations (P3BD) are resolved async via resolveDelayMs — skip estimate here
        if (parseBdDuration(t.duration)) return undefined;
        const ms = parseDurationMs(t.duration);
        return new Date(new Date(subscribedAt).getTime() + ms).toISOString();
      } catch { return undefined; }
    }
  }
  return undefined;
}

// ── Compute UI status ─────────────────────────────────────────────────────────

type UiStatus = "waiting" | "fired" | "error" | "manual_fallback";

function computeUiStatus(sub: Subscription): UiStatus {
  if (sub.error) return "error";
  if (sub.status === "cancelled" && sub.last_fired_at) return "fired";
  if (sub.mode === "manual") return "manual_fallback";
  return "waiting";
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface TimerTrigger {
  kind: "timer";
  cron: string;
}

export interface MessageTrigger {
  kind: "message";
  source: string;   // "bitrix" | "telegram" | "tracker"
  filter: Record<string, unknown>;
}

export interface ConditionTrigger {
  kind: "condition";
  data_source: string;
  query: { entity: string; filter: Record<string, unknown>; metric: string; sum_field?: string };
  operator: ">" | "<" | ">=" | "<=" | "==" | "!=";
  threshold: number;
  poll_interval: string;  // ISO 8601 duration, e.g. "PT30S"
}

export interface DelayAfterTrigger {
  kind: "delay_after";
  duration: string;   // ISO 8601 duration, e.g. "PT1H"
  ref_event?: string; // metadata only — countdown starts at subscribe time
}

export type TriggerDef =
  | TimerTrigger
  | MessageTrigger
  | ConditionTrigger
  | DelayAfterTrigger
  | { kind: string; [key: string]: unknown };

export interface Subscription {
  id: string;
  event_id: string;
  event_label?: string;      // human-readable event label from process definition
  process_id: string;
  process_name?: string;     // human-readable process name
  instance_id: string;
  trigger: TriggerDef;
  status: "active" | "cancelled";
  mode: "auto" | "manual";
  subscribed_at: string;
  next_fire_at?: string;     // computed: next scheduled fire time (timers)
  last_fired_at?: string;
  fire_count?: number;       // total number of times fired
  last_poll_at?: string;     // last condition poll time
  last_poll_result?: unknown; // last condition poll result
  error?: string;            // last error message
}

// ── Summary builder ───────────────────────────────────────────────────────────

function buildSummary(
  subs: Array<Subscription & { ui_status: UiStatus }>,
  todayStart: Date,
  todayEnd: Date,
): Record<string, number> {
  const waiting = subs.filter(s => s.ui_status === "waiting").length;
  const errors = subs.filter(s => s.ui_status === "error").length;
  const manual_fallback = subs.filter(s => s.ui_status === "manual_fallback").length;
  const fired_today = subs.filter(s =>
    s.last_fired_at &&
    new Date(s.last_fired_at) >= todayStart &&
    new Date(s.last_fired_at) <= todayEnd,
  ).length;
  return {
    total: subs.length,
    waiting,
    fired_today,
    errors,
    manual_fallback,
  };
}

// ── In-memory cron task registry ─────────────────────────────────────────────

const activeTasks = new Map<string, nodeCron.ScheduledTask>();

// ── DataAdapter registry ──────────────────────────────────────────────────────

const dataAdapters = new Map<string, DataAdapter>([
  ["bitrix", bitrixAdapter],
  ["telegram", telegramBotAdapter],
  ["tracker", trackerAdapter],
]);

// Maps subscriptionId → ListenerHandle (for message triggers)
const activeListeners = new Map<string, ListenerHandle>();

// Maps subscriptionId → condition poll timer
const conditionTimers = new Map<string, ReturnType<typeof setInterval>>();

// ── BullMQ queue for delay_after triggers ────────────────────────────────────

const DELAY_QUEUE_NAME = "event-manager-delay";

const delayQueue = new Queue(DELAY_QUEUE_NAME, { connection: REDIS_CONNECTION_OPTS });

let delayWorker: Worker | null = null;

export function startDelayWorker(): void {
  if (delayWorker) return;

  delayWorker = new Worker(
    DELAY_QUEUE_NAME,
    async (job) => {
      const { subscription_id } = job.data as { subscription_id: string };
      const raw = await redis.hget(SUBSCRIPTIONS_KEY, subscription_id);
      if (!raw) return; // already gone
      const sub: Subscription = JSON.parse(raw);
      if (sub.status !== "active") return; // already cancelled

      const trigger = sub.trigger as DelayAfterTrigger;
      await publishEventFired(sub, {
        duration: trigger.duration,
        ref_event: trigger.ref_event ?? null,
      });

      // delay_after fires once — auto-cancel
      sub.status = "cancelled";
      await redis.hset(SUBSCRIPTIONS_KEY, sub.id, JSON.stringify(sub));
      console.log(`[event-manager] delay_after fired and cancelled sub=${sub.id}`);
    },
    { connection: REDIS_CONNECTION_OPTS },
  );

  delayWorker.on("failed", (job, err) => {
    console.error(`[event-manager] delay job failed job=${job?.id}: ${err.message}`);
  });

  console.log("[event-manager] delay_after worker started");
}

// ── Retry with exponential backoff ───────────────────────────────────────────

const MAX_RETRY_ATTEMPTS = 5;
const RETRY_BASE_MS = 1000;

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxAttempts = MAX_RETRY_ATTEMPTS,
): Promise<T> {
  let lastError: Error = new Error("unknown");
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      lastError = e;
      const delayMs = RETRY_BASE_MS * Math.pow(2, attempt);
      console.warn(`[event-manager] ${label} attempt ${attempt + 1}/${maxAttempts} failed: ${e.message}. Retrying in ${delayMs}ms…`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}

// ── ISO 8601 duration parser (subset: PT<n>S / PT<n>M / PT<n>H / P<n>D) ─────
// P{N}BD (business day durations) are NOT handled here — use resolveDelayMs() instead.

function parseDurationMs(iso: string): number {
  const match = iso.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  if (!match) throw new Error(`Invalid ISO 8601 duration: "${iso}"`);
  const [, d, h, m, s] = match;
  return (
    (parseInt(d ?? "0") * 86400 +
     parseInt(h ?? "0") * 3600 +
     parseInt(m ?? "0") * 60 +
     parseFloat(s ?? "0")) * 1000
  );
}

/**
 * Resolve a delay duration to milliseconds.
 * Handles both standard ISO 8601 and P{N}BD (business day) durations.
 * For BD durations, subscribedAt is the reference date.
 */
async function resolveDelayMs(duration: string, subscribedAt: string): Promise<number> {
  // Business day duration (e.g. P3BD)
  const { parseBdDuration, addBusinessDays } = await import("./work-calendar");
  const bd = parseBdDuration(duration);
  if (bd) {
    const fromDate = subscribedAt.slice(0, 10); // YYYY-MM-DD
    const targetDate = await addBusinessDays(fromDate, bd.businessDays);
    const targetMs = new Date(targetDate + "T09:00:00.000Z").getTime();
    const delayMs = targetMs - Date.now();
    if (delayMs <= 0) return 1000; // fire immediately if already past
    return delayMs;
  }
  return parseDurationMs(duration);
}

// ── Condition evaluation ──────────────────────────────────────────────────────

function evalCondition(value: number, op: string, threshold: number): boolean {
  switch (op) {
    case ">":  return value > threshold;
    case "<":  return value < threshold;
    case ">=": return value >= threshold;
    case "<=": return value <= threshold;
    case "==": return value === threshold;
    case "!=": return value !== threshold;
    default:   return false;
  }
}

// ── Publish event_fired on the bus ────────────────────────────────────────────

async function publishEventFired(
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
  };

  await sendMessage({
    from: SENDER,
    to: "workflow-engine",
    type: "event_fired",
    text: JSON.stringify(payload),
  });

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
  // Trim to last HISTORY_MAX_ENTRIES entries
  await redis.zremrangebyrank(HISTORY_KEY, 0, -(HISTORY_MAX_ENTRIES + 1));

  console.log(
    `[event-manager] event_fired sub=${sub.id} event_id=${sub.event_id} process_id=${sub.process_id} kind=${sub.trigger.kind}`,
  );
}

// ── Cron scheduling ───────────────────────────────────────────────────────────

function scheduleCron(sub: Subscription): void {
  const trigger = sub.trigger as TimerTrigger;
  if (!trigger.cron) return;

  // Cancel any existing task for this subscription
  const existing = activeTasks.get(sub.id);
  if (existing) {
    existing.stop();
    activeTasks.delete(sub.id);
  }

  if (!nodeCron.validate(trigger.cron)) {
    console.warn(`[event-manager] invalid cron expr sub=${sub.id}: "${trigger.cron}"`);
    return;
  }

  const task = nodeCron.schedule(trigger.cron, async () => {
    try {
      await publishEventFired(sub, { cron: trigger.cron });
    } catch (e: any) {
      console.error(`[event-manager] cron fire error sub=${sub.id}: ${e.message}`);
    }
  });

  activeTasks.set(sub.id, task);
  console.log(`[event-manager] scheduled cron sub=${sub.id} expr="${trigger.cron}"`);
}

function cancelCron(id: string): void {
  const task = activeTasks.get(id);
  if (task) {
    task.stop();
    activeTasks.delete(id);
    console.log(`[event-manager] cancelled cron sub=${id}`);
  }
}

// ── Missed firing detection ───────────────────────────────────────────────────
//
// On restart, check if any cron should have fired between last_fired_at and now.
// For each missed occurrence, publish a delayed event_fired with source_data.missed=true.

async function checkMissedFirings(sub: Subscription): Promise<void> {
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
        // CronExpressionParser throws when exhausted
        missed.push(next.toDate());
      } catch {
        break;
      }
    }

    if (missed.length > 0) {
      console.log(
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
    console.warn(`[event-manager] missed firing check error sub=${sub.id}: ${e.message}`);
  }
}

// ── Activate delay_after trigger ─────────────────────────────────────────────

async function activateDelayAfterTrigger(sub: Subscription): Promise<void> {
  const trigger = sub.trigger as DelayAfterTrigger;
  let delayMs: number;
  try {
    delayMs = await resolveDelayMs(trigger.duration, sub.subscribed_at || new Date().toISOString());
  } catch (e: any) {
    console.warn(`[event-manager] invalid delay_after duration sub=${sub.id}: ${e.message}`);
    return;
  }

  // Check if a job already exists (idempotent)
  const existingJob = await delayQueue.getJob(sub.id).catch(() => null);
  if (existingJob) {
    console.log(`[event-manager] delay_after job already queued sub=${sub.id}`);
    return;
  }

  await delayQueue.add("fire", { subscription_id: sub.id }, {
    jobId: sub.id,
    delay: delayMs,
    removeOnComplete: true,
    removeOnFail: { count: 5 },
  });

  console.log(`[event-manager] delay_after queued sub=${sub.id} delay=${delayMs}ms`);
}

// ── Activate message trigger ──────────────────────────────────────────────────

async function activateMessageTrigger(sub: Subscription): Promise<void> {
  const trigger = sub.trigger as MessageTrigger;
  const adapter = dataAdapters.get(trigger.source);
  if (!adapter) {
    console.warn(`[event-manager] no DataAdapter for source="${trigger.source}" sub=${sub.id} → manual mode`);
    return;
  }

  // Cancel existing listener if any
  const existing = activeListeners.get(sub.id);
  if (existing) {
    await adapter.removeListener(existing).catch(() => {});
    activeListeners.delete(sub.id);
  }

  try {
    const handle = await withRetry(
      () => adapter.setupListener(trigger.filter, async (payload) => {
        await publishEventFired(sub, { payload }).catch(e =>
          console.error(`[event-manager] message fire error sub=${sub.id}: ${e.message}`),
        );
      }),
      `setupListener sub=${sub.id} source=${trigger.source}`,
    );
    activeListeners.set(sub.id, handle);
    console.log(`[event-manager] message listener activated sub=${sub.id} source=${trigger.source}`);
  } catch (e: any) {
    console.error(`[event-manager] message listener setup exhausted retries sub=${sub.id}: ${e.message} → switching to manual mode`);
    sub.mode = "manual";
    await redis.hset(SUBSCRIPTIONS_KEY, sub.id, JSON.stringify(sub));
  }
}

// ── Activate condition trigger ─────────────────────────────────────────────────

async function activateConditionTrigger(sub: Subscription): Promise<void> {
  const trigger = sub.trigger as ConditionTrigger;
  const adapter = dataAdapters.get(trigger.data_source);
  if (!adapter) {
    console.warn(`[event-manager] no DataAdapter for data_source="${trigger.data_source}" sub=${sub.id} → manual mode`);
    return;
  }

  // Cancel existing condition timer if any
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
    console.warn(`[event-manager] invalid poll_interval sub=${sub.id}, defaulting to 30s`);
  }

  const timer = setInterval(async () => {
    try {
      const value = await withRetry(
        () => adapter.executeQuery({
          entity: trigger.query.entity,
          filter: trigger.query.filter,
          metric: trigger.query.metric as any,
          sum_field: trigger.query.sum_field,
        }),
        `executeQuery sub=${sub.id} source=${trigger.data_source}`,
      );

      // Track poll stats
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

        // Condition fires once: cancel subscription after match
        sub.status = "cancelled";
        await redis.hset(SUBSCRIPTIONS_KEY, sub.id, JSON.stringify(sub));
        clearInterval(timer);
        conditionTimers.delete(sub.id);
        console.log(`[event-manager] condition matched and unsubscribed sub=${sub.id}`);
      }
    } catch (e: any) {
      recordAdapterError(trigger.data_source, e.message);
      console.error(`[event-manager] condition poll exhausted retries sub=${sub.id}: ${e.message} → switching to manual mode`);
      sub.mode = "manual";
      await redis.hset(SUBSCRIPTIONS_KEY, sub.id, JSON.stringify(sub));
      clearInterval(timer);
      conditionTimers.delete(sub.id);
    }
  }, pollMs);

  conditionTimers.set(sub.id, timer);
  console.log(`[event-manager] condition poller activated sub=${sub.id} source=${trigger.data_source} interval=${trigger.poll_interval}`);
}

// ── Cancel all active resources for a subscription ───────────────────────────

async function cancelSubscriptionResources(sub: Subscription): Promise<void> {
  const { id, trigger } = sub;

  if (trigger.kind === "timer") {
    cancelCron(id);
  } else if (trigger.kind === "message") {
    const handle = activeListeners.get(id);
    if (handle) {
      const adapter = dataAdapters.get((trigger as MessageTrigger).source);
      await adapter?.removeListener(handle).catch(() => {});
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
    await job?.remove().catch(() => {});
    console.log(`[event-manager] delay_after job removed sub=${id}`);
  }
}

// ── Restore delay_after subscription ─────────────────────────────────────────

async function restoreDelayAfterSub(sub: Subscription): Promise<void> {
  const trigger = sub.trigger as DelayAfterTrigger;

  // Job is stored in Redis by BullMQ — check if it's still there
  const existingJob = await delayQueue.getJob(sub.id).catch(() => null);
  if (existingJob) {
    console.log(`[event-manager] delay_after job still queued in BullMQ sub=${sub.id}`);
    return;
  }

  // Job was lost — compute remaining delay and re-add (handles both ISO 8601 and P{N}BD)
  let durationMs: number;
  try {
    durationMs = await resolveDelayMs(trigger.duration, sub.subscribed_at || new Date().toISOString());
  } catch (e: any) {
    console.warn(`[event-manager] delay_after restore: invalid duration sub=${sub.id}: ${e.message}`);
    return;
  }

  // resolveDelayMs returns ms from now for BD, but for ISO 8601 it returns total ms from subscribedAt
  // Re-calculate remaining for ISO 8601 case (BD already returns from-now delay)
  const isBd = parseBdDuration(trigger.duration);
  const remainingMs = isBd ? durationMs : new Date(sub.subscribed_at).getTime() + durationMs - Date.now();

  if (remainingMs <= 0) {
    // Already past due — fire immediately
    console.log(`[event-manager] delay_after past due on restore sub=${sub.id} — firing now`);
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
    console.log(`[event-manager] delay_after re-queued sub=${sub.id} remaining=${remainingMs}ms`);
  }
}

// ── Restore subscriptions on startup ─────────────────────────────────────────

export async function restoreSubscriptions(): Promise<void> {
  const all = await redis.hgetall(SUBSCRIPTIONS_KEY).catch(() => ({}));
  const subs = Object.values(all).map(v => JSON.parse(v) as Subscription);
  const active = subs.filter(s => s.status === "active");

  console.log(`[event-manager] restoring ${active.length} active subscription(s)`);

  for (const sub of active) {
    if (sub.trigger.kind === "timer") {
      await checkMissedFirings(sub).catch(e =>
        console.error(`[event-manager] missed firing check failed sub=${sub.id}: ${e.message}`),
      );
      const fresh = await redis.hget(SUBSCRIPTIONS_KEY, sub.id);
      const freshSub: Subscription = fresh ? JSON.parse(fresh) : sub;
      scheduleCron(freshSub);
    } else if (sub.trigger.kind === "message") {
      await activateMessageTrigger(sub).catch(e =>
        console.error(`[event-manager] message listener restore failed sub=${sub.id}: ${e.message}`),
      );
    } else if (sub.trigger.kind === "condition") {
      await activateConditionTrigger(sub).catch(e =>
        console.error(`[event-manager] condition poller restore failed sub=${sub.id}: ${e.message}`),
      );
    } else if (sub.trigger.kind === "delay_after") {
      // BullMQ jobs survive in Redis across restarts — check if job still exists,
      // re-add with remaining time if it was lost (e.g. Redis flush).
      await restoreDelayAfterSub(sub).catch(e =>
        console.error(`[event-manager] delay_after restore failed sub=${sub.id}: ${e.message}`),
      );
    } else {
      console.log(`[event-manager] sub=${sub.id} kind=${sub.trigger.kind} → manual mode`);
    }
  }

  console.log(`[event-manager] restored ${activeTasks.size} cron job(s), ${activeListeners.size} listener(s), ${conditionTimers.size} condition poller(s)`);
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerEventManagerRoutes(
  app: Hono<HonoEnv>,
  requireAuth: MiddlewareHandler<HonoEnv>,
): void {
  // POST /api/event-manager/subscribe
  app.post("/event-manager/subscribe", requireAuth, async (c) => {
    const body = await c.req.json<{
      event_id: string;
      event_label?: string;
      process_id: string;
      process_name?: string;
      instance_id: string;
      trigger: TriggerDef;
    }>().catch(() => null);

    if (!body?.event_id || !body?.process_id || !body?.instance_id || !body?.trigger) {
      return c.json({ error: "event_id, process_id, instance_id, trigger required" }, 400);
    }

    const trigger = body.trigger;
    let mode: "auto" | "manual" = "manual";

    if (trigger.kind === "timer") {
      const cronExpr = (trigger as TimerTrigger).cron;
      if (!cronExpr) return c.json({ error: "trigger.cron required for timer kind" }, 400);
      if (!nodeCron.validate(cronExpr)) {
        return c.json({ error: `invalid cron expression: "${cronExpr}"` }, 400);
      }
      mode = "auto";
    } else if (trigger.kind === "message") {
      const mt = trigger as MessageTrigger;
      if (!mt.source) return c.json({ error: "trigger.source required for message kind" }, 400);
      if (!dataAdapters.has(mt.source)) {
        return c.json({ error: `unknown data source: "${mt.source}"` }, 400);
      }
      mode = "auto";
    } else if (trigger.kind === "condition") {
      const ct = trigger as ConditionTrigger;
      if (!ct.data_source) return c.json({ error: "trigger.data_source required for condition kind" }, 400);
      if (!dataAdapters.has(ct.data_source)) {
        return c.json({ error: `unknown data source: "${ct.data_source}"` }, 400);
      }
      if (!ct.query?.entity) return c.json({ error: "trigger.query.entity required" }, 400);
      if (!ct.operator) return c.json({ error: "trigger.operator required" }, 400);
      if (ct.threshold === undefined) return c.json({ error: "trigger.threshold required" }, 400);
      if (!ct.poll_interval) return c.json({ error: "trigger.poll_interval required (ISO 8601 duration)" }, 400);
      mode = "auto";
    } else if (trigger.kind === "delay_after") {
      const dt = trigger as DelayAfterTrigger;
      if (!dt.duration) return c.json({ error: "trigger.duration required for delay_after kind (ISO 8601 or P{N}BD)" }, 400);
      if (!parseBdDuration(dt.duration)) {
        try { parseDurationMs(dt.duration); } catch {
          return c.json({ error: `invalid duration: "${dt.duration}" (use ISO 8601 or P{N}BD format)` }, 400);
        }
      }
      mode = "auto";
    }

    // Deduplication: if an active subscription already exists for the same
    // process_id + event_id + trigger.kind, return it instead of creating a duplicate.
    // This prevents event storms when agents restart and re-register their workflows.
    const existingRaw = await redis.hgetall(SUBSCRIPTIONS_KEY).catch(() => ({}));
    for (const raw of Object.values(existingRaw)) {
      const existing = JSON.parse(raw) as Subscription;
      if (
        existing.status === "active" &&
        existing.process_id === body.process_id &&
        existing.event_id === body.event_id &&
        existing.trigger.kind === trigger.kind
      ) {
        console.log(
          `[event-manager] dedup: returning existing sub=${existing.id} for process=${body.process_id} event=${body.event_id} kind=${trigger.kind}`,
        );
        return c.json({ subscription_id: existing.id, status: existing.status, mode: existing.mode });
      }
    }

    const now = new Date().toISOString();
    const sub: Subscription = {
      id: `sub_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      event_id: body.event_id,
      event_label: body.event_label,
      process_id: body.process_id,
      process_name: body.process_name,
      instance_id: body.instance_id,
      trigger,
      status: "active",
      mode,
      subscribed_at: now,
      fire_count: 0,
      next_fire_at: computeNextFireAt(trigger, now),
    };

    await redis.hset(SUBSCRIPTIONS_KEY, sub.id, JSON.stringify(sub));

    if (mode === "auto") {
      if (trigger.kind === "timer") {
        scheduleCron(sub);
      } else if (trigger.kind === "message") {
        await activateMessageTrigger(sub).catch(e =>
          console.error(`[event-manager] message listener setup failed sub=${sub.id}: ${e.message}`),
        );
      } else if (trigger.kind === "condition") {
        await activateConditionTrigger(sub).catch(e =>
          console.error(`[event-manager] condition poller setup failed sub=${sub.id}: ${e.message}`),
        );
      } else if (trigger.kind === "delay_after") {
        await activateDelayAfterTrigger(sub).catch(e =>
          console.error(`[event-manager] delay_after queue failed sub=${sub.id}: ${e.message}`),
        );
      }
    }

    console.log(
      `[event-manager] subscribed id=${sub.id} event_id=${sub.event_id} process_id=${sub.process_id} kind=${trigger.kind} mode=${mode}`,
    );

    return c.json({ subscription_id: sub.id, status: sub.status, mode });
  });

  // DELETE /api/event-manager/subscribe/:id
  app.delete("/event-manager/subscribe/:id", requireAuth, async (c) => {
    const id = c.req.param("id");
    const raw = await redis.hget(SUBSCRIPTIONS_KEY, id);
    if (!raw) return c.json({ error: "Subscription not found" }, 404);

    const sub: Subscription = JSON.parse(raw);
    sub.status = "cancelled";
    await redis.hset(SUBSCRIPTIONS_KEY, id, JSON.stringify(sub));

    await cancelSubscriptionResources(sub);

    console.log(`[event-manager] cancelled subscription id=${id}`);
    return c.json({ ok: true, id, status: "cancelled" });
  });

  // GET /api/event-manager/subscriptions
  app.get("/event-manager/subscriptions", requireAuth, async (c) => {
    const processId = c.req.query("process_id");
    const instanceId = c.req.query("instance_id");
    const triggerKind = c.req.query("trigger_kind");
    const source = c.req.query("source");
    const statusFilter = c.req.query("status") as UiStatus | undefined;

    const all = await redis.hgetall(SUBSCRIPTIONS_KEY).catch(() => ({}));
    let subs = Object.values(all).map(v => JSON.parse(v) as Subscription);

    if (processId) subs = subs.filter(s => s.process_id === processId);
    if (instanceId) subs = subs.filter(s => s.instance_id === instanceId);
    if (triggerKind) subs = subs.filter(s => s.trigger.kind === triggerKind);
    if (source) subs = subs.filter(s => {
      const t = s.trigger as any;
      return t.source === source || t.data_source === source;
    });

    // Compute UI status and next_fire_at for each subscription
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const enriched = subs.map(s => {
      const ui_status = computeUiStatus(s);
      const next_fire_at = s.next_fire_at ?? computeNextFireAt(s.trigger, s.subscribed_at);
      return { ...s, ui_status, next_fire_at };
    });

    if (statusFilter) {
      const filtered = enriched.filter(s => s.ui_status === statusFilter);
      const summary = buildSummary(enriched, todayStart, todayEnd);
      return c.json({ subscriptions: filtered, summary });
    }

    const summary = buildSummary(enriched, todayStart, todayEnd);
    return c.json({ subscriptions: enriched, summary });
  });

  // GET /api/event-manager/history
  app.get("/event-manager/history", requireAuth, async (c) => {
    const processId = c.req.query("process_id");
    const instanceId = c.req.query("instance_id");
    const since = c.req.query("since");
    const until = c.req.query("until");
    const limitStr = c.req.query("limit");
    const limit = limitStr ? Math.min(parseInt(limitStr), 200) : 50;

    const minScore = since ? new Date(since).getTime() : "-inf";
    const maxScore = until ? new Date(until).getTime() : "+inf";

    const raw = await redis.zrangebyscore(HISTORY_KEY, minScore, maxScore, "LIMIT", 0, limit)
      .catch(() => [] as string[]);

    interface EventHistoryEntry {
      subscription_id: string;
      event_id: string;
      event_label?: string;
      process_id: string;
      process_name?: string;
      instance_id: string;
      trigger_kind: string;
      fired_at: string;
      source_data?: unknown;
    }
    let entries: EventHistoryEntry[] = raw.map(r => JSON.parse(r) as EventHistoryEntry);

    if (processId) entries = entries.filter((e) => e.process_id === processId);
    if (instanceId) entries = entries.filter((e) => e.instance_id === instanceId);

    return c.json({ history: entries, total: entries.length });
  });

  // GET /api/event-manager/adapters/status
  app.get("/event-manager/adapters/status", requireAuth, async (c) => {
    const result = Array.from(dataAdapters.keys()).map(name => {
      const stats = adapterStats.get(name) ?? { name, error_count: 0, active_listeners: 0 };
      // Count active listeners for this adapter
      const listenerCount = Array.from(activeListeners.values()).filter(h => h.adapter === name).length;

      let status: "available" | "degraded" | "unavailable" = "available";
      if (!stats.last_success_at && stats.error_count > 0) status = "unavailable";
      else if (stats.last_error_at && stats.last_success_at && stats.last_error_at > stats.last_success_at) {
        status = stats.error_count > 3 ? "unavailable" : "degraded";
      }

      return {
        name,
        status,
        last_success_at: stats.last_success_at ?? null,
        last_error_at: stats.last_error_at ?? null,
        last_error: stats.last_error ?? null,
        error_count: stats.error_count,
        active_listeners: listenerCount,
      };
    });

    return c.json({ adapters: result });
  });

  // POST /api/webhooks/bitrix — Bitrix24 event push dispatch (no auth, validated by handle param)
  app.post("/webhooks/bitrix", async (c) => {
    const handleId = c.req.query("handle");
    if (!handleId) return c.json({ error: "handle required" }, 400);

    const cb = listenerRegistry.get(handleId);
    if (!cb) {
      // Handle may have been cleaned up; return 200 to stop Bitrix retries
      return c.json({ ok: true, discarded: true });
    }

    const body = await c.req.json().catch(() => null);
    try {
      cb(body);
    } catch (e: any) {
      console.error(`[event-manager] bitrix webhook callback error handle=${handleId}: ${e.message}`);
    }

    return c.json({ ok: true });
  });
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
  // This prevents double-registration when subscribeStartEvents() is called again on workflow update/hot-reload.
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
        await cancelSubscriptionResources(existing).catch(() => {});
        console.log(`[event-manager] dedup: cancelled stale sub=${existing.id} for process_id=${params.process_id} event_id=${params.event_id}`);
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
        console.error(`[event-manager] message listener setup failed sub=${sub.id}: ${e.message}`),
      );
    } else if (trigger.kind === "condition") {
      await activateConditionTrigger(sub).catch(e =>
        console.error(`[event-manager] condition poller setup failed sub=${sub.id}: ${e.message}`),
      );
    } else if (trigger.kind === "delay_after") {
      await activateDelayAfterTrigger(sub).catch(e =>
        console.error(`[event-manager] delay_after queue failed sub=${sub.id}: ${e.message}`),
      );
    }
  }

  console.log(
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
      console.warn(`[event-manager] cancel resources error sub=${sub.id}: ${e.message}`),
    );
    console.log(`[event-manager] cancelled sub=${sub.id} for instance_id=${instance_id}`);
  }

  return matching.length;
}
