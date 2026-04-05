/**
 * event-manager.ts — Event Manager module (Phase 1: timer/cron subscriptions).
 *
 * Stores subscriptions in Redis, creates cron jobs for timer triggers,
 * publishes event_fired messages on the Konoha bus on each firing.
 *
 * Phase 1 scope: timer (cron) only.
 * delay_after and data adapters will be added in #230.
 *
 * Endpoints:
 *   POST   /api/event-manager/subscribe
 *   DELETE /api/event-manager/subscribe/:id
 *   GET    /api/event-manager/subscriptions
 */

import { randomUUID } from "crypto";
import * as nodeCron from "node-cron";
import { CronExpressionParser } from "cron-parser";
import { redis, sendMessage } from "./redis";
import type { Hono } from "hono";

const SUBSCRIPTIONS_KEY = "event-manager:subscriptions";
const SENDER = "event-manager";

// ── Types ────────────────────────────────────────────────────────────────────

export interface TimerTrigger {
  kind: "timer";
  cron: string;
}

// Phase 2 will add: message, condition, manual, system triggers
export type TriggerDef = TimerTrigger | { kind: string; [key: string]: unknown };

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
    type: "event",
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

// ── Restore subscriptions on startup ─────────────────────────────────────────

export async function restoreSubscriptions(): Promise<void> {
  const all = await redis.hgetall(SUBSCRIPTIONS_KEY).catch(() => ({}));
  const subs = Object.values(all).map(v => JSON.parse(v) as Subscription);
  const active = subs.filter(s => s.status === "active");

  console.log(`[event-manager] restoring ${active.length} active subscription(s)`);

  for (const sub of active) {
    if (sub.trigger.kind === "timer") {
      // Check for missed firings first (before scheduling, so last_fired_at is fresh)
      await checkMissedFirings(sub).catch(e =>
        console.error(`[event-manager] missed firing check failed sub=${sub.id}: ${e.message}`),
      );
      // Re-read sub from Redis (last_fired_at may have been updated by checkMissedFirings)
      const fresh = await redis.hget(SUBSCRIPTIONS_KEY, sub.id);
      const freshSub: Subscription = fresh ? JSON.parse(fresh) : sub;
      scheduleCron(freshSub);
    } else {
      // Non-timer kinds: manual mode until Phase 2 adapters are implemented
      console.log(`[event-manager] sub=${sub.id} kind=${sub.trigger.kind} → manual mode (adapters not yet implemented)`);
    }
  }

  console.log(`[event-manager] restored ${activeTasks.size} cron job(s)`);
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

    // Determine mode: timer with valid cron → auto; anything else → manual for now
    if (trigger.kind === "timer") {
      const cronExpr = (trigger as TimerTrigger).cron;
      if (!cronExpr) return c.json({ error: "trigger.cron required for timer kind" }, 400);
      if (!nodeCron.validate(cronExpr)) {
        return c.json({ error: `invalid cron expression: "${cronExpr}"` }, 400);
      }
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

    if (mode === "auto" && trigger.kind === "timer") {
      scheduleCron(sub);
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

    cancelCron(id);

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
}
