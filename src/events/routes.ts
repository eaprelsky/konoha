/**
 * events/routes.ts — HTTP route registration for the event manager.
 */

import * as nodeCron from "node-cron";
import type { Hono, MiddlewareHandler } from "hono";
import type { HonoEnv } from "../types";
import { redis } from "../redis";
import { parseBdDuration } from "../work-calendar";
import { createLogger } from "../logger";
import { listenerRegistry } from "../adapters/data-adapter";
import type { Subscription, TriggerDef, TimerTrigger, MessageTrigger, ConditionTrigger, DelayAfterTrigger, UiStatus } from "./types";
import { computeNextFireAt, computeUiStatus, buildSummary, parseDurationMs } from "./utils";
import {
  SUBSCRIPTIONS_KEY,
  HISTORY_KEY,
  dataAdapters,
  activeListeners,
  scheduleCron,
  activateMessageTrigger,
  activateConditionTrigger,
  activateDelayAfterTrigger,
  cancelSubscriptionResources,
} from "./subscriptions";
import { DEFAULT_MAX_RPS, adapterStats, adapterRateLimiters } from "./utils";
import { randomUUID } from "crypto";
import { requireAdmin } from "../middleware/auth";

const log = createLogger("event-manager");
export function registerEventManagerRoutes(
  app: Hono<HonoEnv>,
  requireAuth: MiddlewareHandler<HonoEnv>,
): void {
  // POST /api/event-manager/subscribe
  app.post("/event-manager/subscribe", requireAdmin, async (c) => {
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
    const existingRaw = await redis.hgetall(SUBSCRIPTIONS_KEY).catch(() => ({}));
    for (const raw of Object.values(existingRaw)) {
      const existing = JSON.parse(raw) as Subscription;
      if (
        existing.status === "active" &&
        existing.process_id === body.process_id &&
        existing.event_id === body.event_id &&
        existing.trigger.kind === trigger.kind
      ) {
        log.info(
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
      `[event-manager] subscribed id=${sub.id} event_id=${sub.event_id} process_id=${sub.process_id} kind=${trigger.kind} mode=${mode}`,
    );

    return c.json({ subscription_id: sub.id, status: sub.status, mode });
  });

  // DELETE /api/event-manager/subscribe/:id
  app.delete("/event-manager/subscribe/:id", requireAdmin, async (c) => {
    const id = c.req.param("id")!;
    const raw = await redis.hget(SUBSCRIPTIONS_KEY, id);
    if (!raw) return c.json({ error: "Subscription not found" }, 404);

    const sub: Subscription = JSON.parse(raw);
    sub.status = "cancelled";
    await redis.hset(SUBSCRIPTIONS_KEY, id, JSON.stringify(sub));

    await cancelSubscriptionResources(sub);

    log.info(`[event-manager] cancelled subscription id=${id}`);
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
      const listenerCount = Array.from(activeListeners.values()).filter(h => h.adapter === name).length;

      let status: "available" | "degraded" | "unavailable" = "available";
      if (!stats.last_success_at && stats.error_count > 0) status = "unavailable";
      else if (stats.last_error_at && stats.last_success_at && stats.last_error_at > stats.last_success_at) {
        status = stats.error_count > 3 ? "unavailable" : "degraded";
      }

      const rl = adapterRateLimiters.get(name);
      const envKey = `ADAPTER_MAX_RPS_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
      const configuredRps = parseFloat(process.env[envKey] || '') || DEFAULT_MAX_RPS;

      return {
        name,
        status,
        last_success_at: stats.last_success_at ?? null,
        last_error_at: stats.last_error_at ?? null,
        last_error: stats.last_error ?? null,
        error_count: stats.error_count,
        active_listeners: listenerCount,
        rate_limit: { max_rps: configuredRps, active: !!rl },
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
      return c.json({ ok: true, discarded: true });
    }

    const body = await c.req.json().catch(() => null);
    try {
      cb(body);
    } catch (e: any) {
      log.error(`[event-manager] bitrix webhook callback error handle=${handleId}: ${e.message}`);
    }

    return c.json({ ok: true });
  });
}
