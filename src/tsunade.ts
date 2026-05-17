// Tsunade — lightweight event handler in Konoha bus (KWE-006)
// Not a full Claude agent. Registers on the bus and reacts to process/workitem events.
//
// Subscribed events: process.exception, workitem.stuck, workitem.overdue
// Actions: log + notify naruto (exceptions) or work item assignee (stuck/overdue)
//
// Uses stream-based polling (XREADGROUP on konoha:agent:tsunade) instead of pub/sub
// so that test Redis DB (1) and production DB (0) are fully isolated.

import Redis from "ioredis";
import { registerAgent, sendMessage, REDIS_CONNECTION_OPTS, sampleEnsureGroupMetrics } from "./redis";
import { silentCatch, createLogger } from "./logger";

const log = createLogger("tsunade");
import { getBranding } from "./routes/audit";
import { recoverStuckWorkItems } from "./runtime/work-items";
import { cleanupExpiredRuntimeArtifacts } from "./retention/runtime-cleanup";

const TSUNADE_ID = "tsunade";
const TSUNADE_STREAM = `konoha:agent:${TSUNADE_ID}`;
const TSUNADE_GROUP = "tsunade-handler";

interface KonohaEvent {
  type: string;
  source: string;
  payload: Record<string, unknown>;
  timestamp: string;
  village_id: string;
}

async function handleEvent(event: KonohaEvent): Promise<void> {
  const { type, payload } = event;
  const ts = new Date().toISOString();

  switch (type) {
    case "process.exception": {
      const caseId = payload.case_id ?? "unknown";
      const error = payload.error ?? "unknown error";
      log.error("process.exception", { case_id: String(caseId), error: String(error) });
      await sendMessage({
        from: TSUNADE_ID,
        to: "naruto",
        type: "message",
        text: `[Tsunade] Process exception in case ${caseId}: ${error}`,
        timestamp: ts,
        village_id: event.village_id,
      });
      break;
    }

    case "workitem.stuck": {
      const itemId = payload.work_item_id ?? "unknown";
      const assignee = typeof payload.assignee === "string" && payload.assignee ? payload.assignee : "naruto";
      const label = payload.label ?? "Work item";
      log.warn("workitem.stuck", { work_item_id: String(itemId), assignee });
      await sendMessage({
        from: TSUNADE_ID,
        to: assignee,
        type: "message",
        text: `[Tsunade] Work item stuck: "${label}" (id: ${itemId}) assigned to you`,
        timestamp: ts,
        village_id: event.village_id,
      });
      break;
    }

    case "workitem.overdue": {
      const itemId = payload.work_item_id ?? "unknown";
      const assignee = typeof payload.assignee === "string" && payload.assignee ? payload.assignee : "naruto";
      const label = payload.label ?? "Work item";
      const deadline = payload.deadline ?? "unknown";
      log.warn("workitem.overdue", { work_item_id: String(itemId), assignee, deadline: String(deadline) });
      await sendMessage({
        from: TSUNADE_ID,
        to: assignee,
        type: "message",
        text: `[Tsunade] Work item overdue: "${label}" (id: ${itemId}) deadline was ${deadline}`,
        timestamp: ts,
        village_id: event.village_id,
      });
      break;
    }

    default:
      log.warn("received unknown event type", { type });
  }
}

async function startStreamPoller(pollRedis: Redis): Promise<void> {
  const poll = async () => {
    while (true) {
      try {
        const result = await pollRedis.xreadgroup(
          "GROUP", TSUNADE_GROUP, "worker",
          "COUNT", 10,
          "BLOCK", 5000,
          "STREAMS", TSUNADE_STREAM, ">",
        ) as [string, [string, string[]][]][] | null;

        if (!result) continue;

        for (const [, entries] of result) {
          for (const [entryId, fields] of entries) {
            const obj: Record<string, string> = {};
            for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];

            // Messages have type="event" and text=JSON(KonohaEvent)
            if (obj.type === "event") {
              try {
                const event: KonohaEvent = JSON.parse(obj.text ?? "{}");
                await handleEvent(event);
              } catch (e: any) {
                log.error("handleEvent error", { error: e.message });
              }
            }

            await pollRedis.xack(TSUNADE_STREAM, TSUNADE_GROUP, entryId).catch(silentCatch("tsunade stream ack"));
          }
        }
        // Micro-delay to prevent tight re-poll during message storms (#780)
        await new Promise(r => setTimeout(r, 50));
      } catch (e: any) {
        if (e.message?.includes("NOGROUP")) {
          // Consumer group was destroyed (e.g. stream deleted by cleanup).
          // Recreate it so the poller can continue processing events.
          await pollRedis.xgroup("CREATE", TSUNADE_STREAM, TSUNADE_GROUP, "$", "MKSTREAM")
            .catch(() => {});
        } else if (!e.message?.includes("Connection")) {
          log.error("stream poll error", { error: e.message });
        }
        await new Promise(res => setTimeout(res, 2000));
      }
    }
  };

  poll().catch(e => log.error("poll loop crashed", { error: e.message }));
  log.info("stream event listener started");
}

// ── Work item healthcheck ────────────────────────────────────────────────────

const HEALTHCHECK_INTERVAL_MS = 30_000; // 30 seconds
const configuredRuntimeRetentionIntervalMs = Number(process.env.KONOHA_RUNTIME_RETENTION_INTERVAL_MS);
const RUNTIME_RETENTION_INTERVAL_MS = Number.isFinite(configuredRuntimeRetentionIntervalMs) && configuredRuntimeRetentionIntervalMs > 0
  ? configuredRuntimeRetentionIntervalMs
  : 60 * 60 * 1000;

function startWorkItemHealthcheck(): void {
  // Polling storm detection (#780): track ensureGroup calls per interval.
  // A high cached/call ratio with high total calls indicates the cache is working
  // but the poll loop is still too hot — stream pollers should not call ensureGroup
  // more than ~2-3 times per 30s interval (one per active agent stream).
  const POLL_STORM_THRESHOLD = 60; // ensureGroup calls per 30s interval
  let lastRuntimeRetentionAt = 0;
  const check = async () => {
    try {
      const result = await recoverStuckWorkItems();
      if (result.recovered > 0) {
        log.warn("healthcheck: recovered stuck work items", { recovered: result.recovered, scanned: result.scanned, agents_offline: result.agentsOffline.join(", ") });
        // Notify naruto about recovery
        await sendMessage({
          from: TSUNADE_ID,
          to: "naruto",
          type: "message",
          text: `[Tsunade] Recovered ${result.recovered} stuck work items. Agents offline: ${result.agentsOffline.join(", ") || "none"}`,
          timestamp: new Date().toISOString(),
          village_id: "comind.konoha",
        }).catch(silentCatch("tsunade fire-and-forget"));
      }

      // Polling storm detection (#780)
      const m = sampleEnsureGroupMetrics();
      if (m.calls > POLL_STORM_THRESHOLD) {
        log.warn("healthcheck: possible polling storm", {
          ensureGroup_calls: m.calls,
          ensureGroup_create_attempts: m.createAttempts,
          ensureGroup_created: m.created,
          ensureGroup_busy: m.busy,
          ensureGroup_cached: m.cached,
          ensureGroup_errors: m.errors,
          interval_s: HEALTHCHECK_INTERVAL_MS / 1000,
        });
      }

      const now = Date.now();
      if (now - lastRuntimeRetentionAt >= RUNTIME_RETENTION_INTERVAL_MS) {
        lastRuntimeRetentionAt = now;
        const cleanup = await cleanupExpiredRuntimeArtifacts({ dryRun: false });
        if (cleanup.deleted_count > 0) {
          await sendMessage({
            from: TSUNADE_ID,
            to: "naruto",
            type: "message",
            text: `[Tsunade] Runtime retention deleted ${cleanup.deleted_count} expired cases/workflow runs.`,
            timestamp: new Date().toISOString(),
            village_id: "comind.konoha",
          }).catch(silentCatch("tsunade runtime retention notification"));
        }
      }
    } catch (e: any) {
      log.error("healthcheck error", { error: e.message });
    }
  };

  // Run first check after 10s, then every 30s
  setTimeout(() => {
    check();
    setInterval(check, HEALTHCHECK_INTERVAL_MS);
  }, 10_000);

  // Flush stale agent status to PG
  const flushStale = async () => {
    try {
      const { pgFlushStaleAgents } = await import("./storage/pg-bus");
      const count = await pgFlushStaleAgents();
      if (count > 0) log.info("flushed stale agent statuses to PG", { count });
    } catch (e: any) {
      // ignore — best-effort
    }
  };
  setInterval(flushStale, HEALTHCHECK_INTERVAL_MS);

  log.info("work item healthcheck timer started", { interval_ms: 30000 });
}

export async function initTsunade(): Promise<void> {
  // Dedicated Redis connection for blocking XREADGROUP — must not share with
  // the main redis instance to avoid blocking non-blocking commands.
  const pollRedis = new Redis(REDIS_CONNECTION_OPTS);
  pollRedis.on("error", () => {}); // swallow connection errors

  // Resolve display name from branding config (closes #325 white-labeling)
  const branding = await getBranding().catch(() => null);
  const tsunadeAlias = branding?.agent_display_names?.["tsunade"]
    ?? branding?.assistant_name
    ?? "Цунаде";

  // Register on bus first — tests check the registry entry as a signal
  // that Tsunade is ready to receive events.
  await registerAgent({
    id: TSUNADE_ID,
    name: "Советник",
    display_alias: tsunadeAlias,
    roles: ["architect"],
    capabilities: ["process-monitoring", "event-handler"],
    eventSubscriptions: ["process.exception", "workitem.stuck", "workitem.overdue"],
    village_id: "comind.konoha",
  });

  // Migrate orphaned consumer group "tsunade" (pre-#324 name) if it exists.
  // Old group had last-delivered-id=0-0 and would replay full stream history
  // on every restart. Advance it to "$" unconditionally (closes #326).
  await pollRedis.xgroup("SETID", TSUNADE_STREAM, "tsunade", "$").catch(() => {
    // Group "tsunade" doesn't exist — nothing to migrate
  });

  // Create consumer group synchronously so events published immediately after
  // initTsunade() resolves are not missed (avoids race condition in tests).
  try {
    await pollRedis.xgroup("CREATE", TSUNADE_STREAM, TSUNADE_GROUP, "$", "MKSTREAM");
    log.info("stream consumer group created");
  } catch (e: any) {
    if (!e.message?.includes("BUSYGROUP")) {
      log.error("consumer group error", { error: e.message });
    }
  }

  // Start stream-based event poller (DB-scoped, unlike pub/sub).
  // Events written to konoha:agent:tsunade by publishEvent() are picked up here.
  startStreamPoller(pollRedis);

  // Periodic work-item healthcheck (closes #508)
  // Scans for stuck work items every 30s and recovers those whose assignee is offline.
  startWorkItemHealthcheck();

  log.info("registered on bus, listening for process/workitem events");
}
