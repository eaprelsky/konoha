// Tsunade — lightweight event handler in Konoha bus (KWE-006)
// Not a full Claude agent. Registers on the bus and reacts to process/workitem events.
//
// Subscribed events: process.exception, workitem.stuck, workitem.overdue
// Actions: log + notify naruto (exceptions) or work item assignee (stuck/overdue)

import Redis from "ioredis";
import { registerAgent, sendMessage } from "./redis";

const NOTIFY_CHANNEL = "konoha:notify:tsunade";
const TSUNADE_ID = "tsunade";

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

export async function initTsunade(): Promise<void> {
  // Register Tsunade as a bus participant
  await registerAgent({
    id: TSUNADE_ID,
    name: "Цунаде (Process Monitor)",
    roles: ["architect"],
    capabilities: ["process-monitoring", "event-handler"],
    eventSubscriptions: ["process.exception", "workitem.stuck", "workitem.overdue"],
    village_id: "comind.konoha",
  });

  console.log("[Tsunade] registered on bus, listening for process/workitem events");

  // Subscribe to Tsunade's pub/sub notification channel
  const sub = new Redis({ host: "127.0.0.1", port: 6379 });
  sub.on("error", () => {}); // swallow connection errors

  sub.subscribe(NOTIFY_CHANNEL).catch(() => {});

  sub.on("message", (_channel, raw) => {
    try {
      const msg = JSON.parse(raw);
      // Messages delivered from publishEvent have type="event" and text=JSON(event)
      if (msg.type !== "event") return;
      const event: KonohaEvent = JSON.parse(msg.text);
      handleEvent(event).catch((e) =>
        console.error("[Tsunade] handleEvent error:", e.message)
      );
    } catch (e: any) {
      console.error("[Tsunade] message parse error:", e.message);
    }
  });
}
