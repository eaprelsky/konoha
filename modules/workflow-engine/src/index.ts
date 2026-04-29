import { Hono } from "hono";
import { requireAuth } from "../../../src/middleware/auth";
import { readMessages, ackMessages } from "../../../src/redis";
import { handleEventFired } from "../../../src/runtime/cases/crud";
import { createLogger } from "../../../src/logger";

const log = createLogger("workflow-engine:consumer");
import workflowsRouter from "./routes/workflows";
import { casesRouter, workitemsRouter, waitsRouter, remindersRouter } from "./routes/cases";

const WORKFLOW_ENGINE_AGENT = "workflow-engine";
const CONSUMER = "workflow-engine-consumer";

const app = new Hono();

// Auth middleware for workflow-engine routes
app.use("/cases/*", requireAuth);
app.use("/cases", requireAuth);
app.use("/workitems/*", requireAuth);
app.use("/workitems", requireAuth);
app.use("/waits/*", requireAuth);
app.use("/waits", requireAuth);
app.use("/reminders/*", requireAuth);
app.use("/reminders", requireAuth);

// Mount workflow-engine routers
app.route("/workflows", workflowsRouter);
app.route("/cases", casesRouter);
app.route("/workitems", workitemsRouter);
app.route("/waits", waitsRouter);
app.route("/reminders", remindersRouter);

// ── Event consumer: poll for event_fired messages addressed to workflow-engine ──

let consumerRunning = false;

async function pollEventFired(): Promise<void> {
  if (consumerRunning) return;
  consumerRunning = true;
  const ids: string[] = [];
  try {
    const messages = await readMessages(WORKFLOW_ENGINE_AGENT, 10, CONSUMER);
    for (const msg of messages) {
      if (!msg.id) continue;
      ids.push(msg.id);
      if (msg.type !== "event_fired" || !msg.text) continue;
      try {
        const payload = JSON.parse(msg.text);
        await handleEventFired(payload);
      } catch (e: any) {
        log.error("event_fired consumer: failed to handle message", { id: msg.id, error: e.message });
      }
    }
    if (ids.length > 0) await ackMessages(WORKFLOW_ENGINE_AGENT, CONSUMER, ids);
  } catch (e: any) {
    log.error("event_fired consumer: poll error", { error: e.message });
  } finally {
    consumerRunning = false;
  }
}

// Poll every 5 seconds
const consumerInterval = setInterval(pollEventFired, 5000);
if (consumerInterval.unref) consumerInterval.unref(); // don't block process exit

export default app;
