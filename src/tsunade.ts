// Tsunade — lightweight event handler in Konoha bus (KWE-006)
// Not a full Claude agent. Registers on the bus and reacts to process/workitem events.
//
// Subscribed events: process.exception, workitem.stuck, workitem.overdue
// Actions: log + notify naruto (exceptions) or work item assignee (stuck/overdue)
//
// Uses stream-based polling (XREADGROUP on konoha:agent:tsunade) instead of pub/sub
// so that test Redis DB (1) and production DB (0) are fully isolated.

import Redis from "ioredis";
import { registerAgent, sendMessage, REDIS_CONNECTION_OPTS } from "./redis";
import { silentCatch } from "./logger";
import { getBranding } from "./routes/audit";
import { recoverStuckWorkItems } from "./runtime/work-items";

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
      console.error(`[Tsunade] process.exception case=${caseId}: ${error}`);
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
      console.warn(`[Tsunade] workitem.stuck id=${itemId} assignee=${assignee}`);
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
      console.warn(`[Tsunade] workitem.overdue id=${itemId} assignee=${assignee} deadline=${deadline}`);
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
      console.warn(`[Tsunade] received unknown event type: ${type}`);
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
                console.error("[Tsunade] handleEvent error:", e.message);
              }
            }

            await pollRedis.xack(TSUNADE_STREAM, TSUNADE_GROUP, entryId).catch(silentCatch("tsunade stream ack"));
          }
        }
      } catch (e: any) {
        if (!e.message?.includes("Connection")) {
          console.error("[Tsunade] stream poll error:", e.message);
        }
        await new Promise(res => setTimeout(res, 2000));
      }
    }
  };

  poll().catch(e => console.error("[Tsunade] poll loop crashed:", e.message));
  console.log("[Tsunade] stream event listener started");
}

// ── Work item healthcheck ────────────────────────────────────────────────────

const HEALTHCHECK_INTERVAL_MS = 30_000; // 30 seconds

function startWorkItemHealthcheck(): void {
  const check = async () => {
    try {
      const result = await recoverStuckWorkItems();
      if (result.recovered > 0) {
        console.warn(`[Tsunade] healthcheck: recovered ${result.recovered}/${result.scanned} stuck work items, agents offline: ${result.agentsOffline.join(", ")}`);
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
    } catch (e: any) {
      console.error(`[Tsunade] healthcheck error: ${e.message}`);
    }
  };

  // Run first check after 10s, then every 30s
  setTimeout(() => {
    check();
    setInterval(check, HEALTHCHECK_INTERVAL_MS);
  }, 10_000);

  console.log("[Tsunade] work item healthcheck timer started (30s interval)");
}

export async function initTsunade(): Promise<void> {
  // Dedicated Redis connection for blocking XREADGROUP — must not share with
  // the main redis instance to avoid blocking non-blocking commands.
  const pollRedis = new Redis(REDIS_CONNECTION_OPTS);
  pollRedis.on("error", () => {}); // swallow connection errors

  // Resolve display name from branding config (closes #325 white-labeling)
  const branding = await getBranding().catch(() => null);
  const tsunadeName = branding?.agent_display_names?.["tsunade"]
    ?? branding?.assistant_name
    ?? "Цунаде";

  // Register on bus first — tests check the registry entry as a signal
  // that Tsunade is ready to receive events.
  await registerAgent({
    id: TSUNADE_ID,
    name: `${tsunadeName} (Process Monitor)`,
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
    console.log("[Tsunade] stream consumer group created");
  } catch (e: any) {
    if (!e.message?.includes("BUSYGROUP")) {
      console.error("[Tsunade] consumer group error:", e.message);
    }
  }

  // Start stream-based event poller (DB-scoped, unlike pub/sub).
  // Events written to konoha:agent:tsunade by publishEvent() are picked up here.
  startStreamPoller(pollRedis);

  // Periodic work-item healthcheck (closes #508)
  // Scans for stuck work items every 30s and recovers those whose assignee is offline.
  startWorkItemHealthcheck();

  console.log("[Tsunade] registered on bus, listening for process/workitem events");
}
