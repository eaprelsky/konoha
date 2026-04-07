import { Hono } from "hono";
import { mkdirSync } from "fs";
import { startReminderScheduler } from "./runtime";
import { redis } from "./redis";
import { handleEventFired } from "./runtime";
import { initTsunade } from "./tsunade";
import { registerTriggerResolverRoutes } from "./trigger-resolver";
import { registerEventManagerRoutes, restoreSubscriptions, startDelayWorker } from "./event-manager";
import { registerWorkCalendarRoutes } from "./work-calendar";
import { requireAuth } from "./middleware/auth";
import type { HonoEnv } from "./types";

// Route modules
import agentsRouter from "./routes/agents";
import agentsAvatarRouter from "./routes/agents-avatar";
import messagesRouter, { attachmentsRouter, channelsRouter } from "./routes/messages";
import eventsRouter, { miningRouter } from "./routes/events";
import { casesRouter, workitemsRouter, remindersRouter } from "./routes/cases";
import rolesRouter from "./routes/roles";
import skillsRouter from "./routes/skills";
import documentsRouter from "./routes/documents";
import peopleRouter from "./routes/people";
import avatarsRouter from "./routes/avatars";
import aiRouter from "./routes/ai";
import kbRouter, { kbChatRouter } from "./routes/kb";
import workflowsRouter from "./routes/workflows";
import adminRouter from "./routes/admin";
import { seedSystemAgents } from "./routes/admin";
import staticRouter, { DIST_UI_DIR } from "./middleware/static";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const ATTACHMENTS_DIR = "/opt/shared/attachments";
mkdirSync(ATTACHMENTS_DIR, { recursive: true });

// Prevent ioredis disconnect errors from crashing the process
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException] swallowed:", err.message);
});
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection] swallowed:", reason);
});

const PORT = parseInt(process.env.KONOHA_PORT || "3100");
const app = new Hono<HonoEnv>();

// Static UI files (no auth required)
// Handle /ui/ (trailing slash) — Hono sub-router doesn't match this
app.get("/ui/", (c) => {
  const indexPath = join(DIST_UI_DIR, "index.html");
  if (existsSync(indexPath)) {
    return c.body(readFileSync(indexPath), 200, { "content-type": "text/html; charset=utf-8" });
  }
  return c.redirect("/ui");
});
app.route("/ui", staticRouter);

// Admin + health + webhook trigger + adapters (mixed auth, see admin.ts)
app.route("/", adminRouter);

// Auth-protected route groups
app.use("/messages/*", requireAuth);
app.use("/channels/*", requireAuth);
app.use("/attachments/*", requireAuth);
app.use("/events", requireAuth);
app.use("/events/log", requireAuth);
app.use("/adapters/*", requireAuth);
app.use("/cases/*", requireAuth);
app.use("/cases", requireAuth);
app.use("/workitems/*", requireAuth);
app.use("/workitems", requireAuth);
app.use("/reminders/*", requireAuth);
app.use("/reminders", requireAuth);
app.use("/roles/*", requireAuth);
app.use("/roles", requireAuth);
app.use("/skills/*", requireAuth);
app.use("/skills", requireAuth);
app.use("/documents/*", requireAuth);
app.use("/documents", requireAuth);
app.use("/people", requireAuth);
app.use("/kb", requireAuth);
app.use("/kb/*", requireAuth);
app.use("/mining/*", requireAuth);
app.use("/workspace", requireAuth);
app.use("/workspace/*", requireAuth);

// Mount routers
app.route("/agents", agentsRouter);
app.route("/agents", agentsAvatarRouter);
app.route("/messages", messagesRouter);
app.route("/attachments", attachmentsRouter);
app.route("/channels", channelsRouter);
app.route("/events", eventsRouter);
app.route("/mining", miningRouter);
app.route("/cases", casesRouter);
app.route("/workitems", workitemsRouter);
app.route("/reminders", remindersRouter);
app.route("/roles", rolesRouter);
app.route("/skills", skillsRouter);
app.route("/documents", documentsRouter);
app.route("/people", peopleRouter);
app.route("/", avatarsRouter);
app.route("/", aiRouter);
app.route("/kb", kbRouter);
app.route("/ai", kbChatRouter);
app.route("/workflows", workflowsRouter);

// Register plugin routes
registerTriggerResolverRoutes(app, requireAuth);
registerEventManagerRoutes(app, requireAuth);
registerWorkCalendarRoutes(app, requireAuth);

// Initialize Tsunade event handler (KWE-006)
export const tsunadeReady: Promise<void> = initTsunade().catch((e) => {
  console.error("[tsunade] init error:", e.message);
});

// Start event managers and schedulers
startDelayWorker();
restoreSubscriptions().catch(e => console.error("[event-manager] restore error:", e.message));
startReminderScheduler();
seedSystemAgents().catch(e => console.error("[seed] system agents error:", e.message));

// ── event_fired bus listener (issue #229) ───────────────────────────────────
const ENGINE_STREAM = "konoha:agent:workflow-engine";
const ENGINE_GROUP  = "workflow-engine";

async function startEventFiredListener(): Promise<void> {
  try {
    await redis.xgroup("CREATE", ENGINE_STREAM, ENGINE_GROUP, "$", "MKSTREAM");
    console.log("[workflow-engine] consumer group created");
  } catch (e: any) {
    if (!e.message?.includes("BUSYGROUP")) {
      console.error("[workflow-engine] consumer group error:", e.message);
    }
  }

  const poll = async () => {
    while (true) {
      try {
        const result = await redis.xreadgroup(
          "GROUP", ENGINE_GROUP, "worker",
          "COUNT", 10,
          "BLOCK", 2000,
          "STREAMS", ENGINE_STREAM, ">",
        ) as [string, [string, string[]][]][] | null;

        if (!result) continue;

        for (const [, entries] of result) {
          for (const [entryId, fields] of entries) {
            const obj: Record<string, string> = {};
            for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];

            if (obj.type !== "event_fired") {
              await redis.xack(ENGINE_STREAM, ENGINE_GROUP, entryId).catch(() => {});
              continue;
            }

            try {
              const payload = JSON.parse(obj.text ?? "{}");
              await handleEventFired(payload);
            } catch (e: any) {
              console.error("[workflow-engine] event_fired handler error:", e.message);
            }

            await redis.xack(ENGINE_STREAM, ENGINE_GROUP, entryId).catch(() => {});
          }
        }
      } catch (e: any) {
        if (!e.message?.includes("Connection")) {
          console.error("[workflow-engine] bus poll error:", e.message);
        }
        await new Promise(res => setTimeout(res, 2000));
      }
    }
  };

  poll().catch(e => console.error("[workflow-engine] poll loop crashed:", e.message));
  console.log("[workflow-engine] event_fired listener started");
}

startEventFiredListener().catch(e => console.error("[workflow-engine] listener start error:", e.message));

console.log(`Konoha bus listening on port ${PORT}`);
export { app };
export default {
  port: PORT,
  fetch: app.fetch,
  idleTimeout: 0, // disable Bun's 10s idle timeout — SSE streams stay open indefinitely
};
