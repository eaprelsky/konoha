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
import { redis, sendMessage } from "./redis";
import type { Hono } from "hono";
import type { DataAdapter, ListenerHandle } from "./adapters/data-adapter";
import { listenerRegistry } from "./adapters/data-adapter";
import { bitrixAdapter } from "./adapters/bitrix";
import { telegramBotAdapter } from "./adapters/telegram-bot";
import { trackerAdapter } from "./adapters/tracker";

const SUBSCRIPTIONS_KEY = "event-manager:subscriptions";
const SENDER = "event-manager";

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

export type TriggerDef =
  | TimerTrigger
  | MessageTrigger
  | ConditionTrigger
  | { kind: string; [key: string]: unknown };

export interface Subscription {
  id: string;
  event_id: string;
  process_id: string;
  instance_id: string;
  trigger: TriggerDef;
  status: "active" | "cancelled";
  mode: "auto" | "manual";
  subscribed_at: string;
  last_fired_at?: string;
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

// ── ISO 8601 duration parser (subset: PT<n>S / PT<n>M / PT<n>H / P<n>D) ─────

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

  // Persist last_fired_at
  sub.last_fired_at = firedAt;
  await redis.hset(SUBSCRIPTIONS_KEY, sub.id, JSON.stringify(sub));

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

// ── Activate message trigger ──────────────────────────────────────────────────

async function activateMessageTrigger(sub: Subscription): Promise<void> {
  const trigger = sub.trigger as MessageTrigger;
  const adapter = dataAdapters.get(trigger.source);
  if (!adapter) {
    console.warn(`[event-manager] no DataAdapter for source="${trigger.source}" sub=${sub.id}`);
    return;
  }

  // Cancel existing listener if any
  const existing = activeListeners.get(sub.id);
  if (existing) {
    await adapter.removeListener(existing).catch(() => {});
    activeListeners.delete(sub.id);
  }

  const handle = await adapter.setupListener(trigger.filter, async (payload) => {
    await publishEventFired(sub, { payload }).catch(e =>
      console.error(`[event-manager] message fire error sub=${sub.id}: ${e.message}`),
    );
  });

  activeListeners.set(sub.id, handle);
  console.log(`[event-manager] message listener activated sub=${sub.id} source=${trigger.source}`);
}

// ── Activate condition trigger ─────────────────────────────────────────────────

async function activateConditionTrigger(sub: Subscription): Promise<void> {
  const trigger = sub.trigger as ConditionTrigger;
  const adapter = dataAdapters.get(trigger.data_source);
  if (!adapter) {
    console.warn(`[event-manager] no DataAdapter for data_source="${trigger.data_source}" sub=${sub.id}`);
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
      const value = await adapter.executeQuery({
        entity: trigger.query.entity,
        filter: trigger.query.filter,
        metric: trigger.query.metric as any,
        sum_field: trigger.query.sum_field,
      });

      if (evalCondition(value, trigger.operator, trigger.threshold)) {
        await publishEventFired(sub, {
          data_source: trigger.data_source,
          value,
          operator: trigger.operator,
          threshold: trigger.threshold,
        });
      }
    } catch (e: any) {
      console.error(`[event-manager] condition poll error sub=${sub.id}: ${e.message}`);
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
    } else {
      console.log(`[event-manager] sub=${sub.id} kind=${sub.trigger.kind} → manual mode`);
    }
  }

  console.log(`[event-manager] restored ${activeTasks.size} cron job(s), ${activeListeners.size} listener(s), ${conditionTimers.size} condition poller(s)`);
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerEventManagerRoutes(
  app: Hono<any>,
  requireAuth: (c: any, next: any) => Promise<any>,
): void {
  // POST /api/event-manager/subscribe
  app.post("/api/event-manager/subscribe", requireAuth, async (c) => {
    const body = await c.req.json<{
      event_id: string;
      process_id: string;
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
    }

    const sub: Subscription = {
      id: `sub_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      event_id: body.event_id,
      process_id: body.process_id,
      instance_id: body.instance_id,
      trigger,
      status: "active",
      mode,
      subscribed_at: new Date().toISOString(),
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
      }
    }

    console.log(
      `[event-manager] subscribed id=${sub.id} event_id=${sub.event_id} process_id=${sub.process_id} kind=${trigger.kind} mode=${mode}`,
    );

    return c.json({ subscription_id: sub.id, status: sub.status, mode });
  });

  // DELETE /api/event-manager/subscribe/:id
  app.delete("/api/event-manager/subscribe/:id", requireAuth, async (c) => {
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
  app.get("/api/event-manager/subscriptions", requireAuth, async (c) => {
    const processId = c.req.query("process_id");
    const instanceId = c.req.query("instance_id");

    const all = await redis.hgetall(SUBSCRIPTIONS_KEY).catch(() => ({}));
    let subs = Object.values(all).map(v => JSON.parse(v) as Subscription);

    if (processId) subs = subs.filter(s => s.process_id === processId);
    if (instanceId) subs = subs.filter(s => s.instance_id === instanceId);

    return c.json(subs);
  });

  // POST /api/webhooks/bitrix — Bitrix24 event push dispatch (no auth, validated by handle param)
  app.post("/api/webhooks/bitrix", async (c) => {
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
  process_id: string;
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
  }

  const sub: Subscription = {
    id: `sub_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    event_id: params.event_id,
    process_id: params.process_id,
    instance_id: params.instance_id,
    trigger,
    status: "active",
    mode,
    subscribed_at: new Date().toISOString(),
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
