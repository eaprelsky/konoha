import { Hono } from "hono";
import { mkdirSync } from "fs";
import { startReminderScheduler, restoreReminderJobs } from "./runtime";
import { redis, createRedis } from "./redis";
import { getAgentDef, listAgentDefs, buildSystemPrompt } from "./agent-lifecycle";
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
import whitelistRouter from "./routes/whitelist";
import adminRouter from "./routes/admin";
import githubRouter from "./routes/github";
import auditRouter from "./routes/audit";
import { seedSystemAgents } from "./routes/admin";
import staticRouter, { DIST_UI_DIR } from "./middleware/static";
import { existsSync, readFileSync, writeFileSync } from "fs";
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
app.route("/whitelist", whitelistRouter);
app.route("/", githubRouter); // POST /webhooks/github — HMAC verified, no auth middleware
app.route("/", auditRouter); // GET /audit, POST /github/issues, GET|PUT /config/autonomy

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
restoreReminderJobs().catch(e => console.error("[reminder-scheduler] restore error:", e.message));
seedSystemAgents().catch(e => console.error("[seed] system agents error:", e.message));

// ── event_fired bus listener (issue #229) ───────────────────────────────────
const ENGINE_STREAM = "konoha:agent:workflow-engine";
const ENGINE_GROUP  = "workflow-engine";

async function startEventFiredListener(): Promise<void> {
  // Dedicated connection for blocking XREADGROUP — must not share with the main redis
  // instance to avoid blocking non-blocking commands queued on the same connection.
  const listenerRedis = createRedis();

  try {
    await listenerRedis.xgroup("CREATE", ENGINE_STREAM, ENGINE_GROUP, "$", "MKSTREAM");
    console.log("[workflow-engine] consumer group created");
  } catch (e: any) {
    if (!e.message?.includes("BUSYGROUP")) {
      console.error("[workflow-engine] consumer group error:", e.message);
    }
  }

  const poll = async () => {
    while (true) {
      try {
        const result = await listenerRedis.xreadgroup(
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
              await listenerRedis.xack(ENGINE_STREAM, ENGINE_GROUP, entryId).catch(() => {});
              continue;
            }

            try {
              const payload = JSON.parse(obj.text ?? "{}");
              await handleEventFired(payload);
            } catch (e: any) {
              console.error("[workflow-engine] event_fired handler error:", e.message);
            }

            await listenerRedis.xack(ENGINE_STREAM, ENGINE_GROUP, entryId).catch(() => {});
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

// ── Hot-reload: regenerate CLAUDE.md for affected agents when workflows change ──
// Listens to `konoha:agent-reload` stream (written by workflow-loader on updateWorkflow).
// Does NOT restart agents — just rewrites their CLAUDE.md so the next /new picks it up.
async function startAgentHotReload(): Promise<void> {
  const RELOAD_STREAM = "konoha:agent-reload";
  const RELOAD_GROUP = "konoha-server-hotreload";
  const WORKDIR_ROOT = "/opt/shared/agent-workdirs";

  const reloadRedis = createRedis();

  try {
    await reloadRedis.xgroup("CREATE", RELOAD_STREAM, RELOAD_GROUP, "$", "MKSTREAM");
  } catch {
    // group already exists
  }

  const poll = async () => {
    while (true) {
      try {
        const result = await reloadRedis.xreadgroup(
          "GROUP", RELOAD_GROUP, "server",
          "COUNT", 10, "BLOCK", 5000,
          "STREAMS", RELOAD_STREAM, ">",
        ) as [string, [string, string[]][]][] | null;

        if (!result) continue;

        for (const [, entries] of result) {
          for (const [entryId, fields] of entries) {
            const obj: Record<string, string> = {};
            for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];

            if (obj.type === "workflow.updated" || obj.type === "role.assigned") {
              // Regenerate CLAUDE.md for all managed agents (role assignments may have changed)
              try {
                const defs = await listAgentDefs();
                for (const def of defs) {
                  const workdir = join(WORKDIR_ROOT, def.id);
                  const claudeMdPath = join(workdir, "CLAUDE.md");
                  if (existsSync(claudeMdPath)) {
                    const claudeMd = await buildSystemPrompt(def.id, def);
                    writeFileSync(claudeMdPath, claudeMd, "utf-8");
                    console.log(`[hot-reload] Regenerated CLAUDE.md for agent "${def.id}" (${obj.type})`);
                  }
                }
              } catch (e: any) {
                console.error("[hot-reload] Failed to regenerate CLAUDE.md:", e.message);
              }
            }

            await reloadRedis.xack(RELOAD_STREAM, RELOAD_GROUP, entryId).catch(() => {});
          }
        }
      } catch (e: any) {
        if (!e.message?.includes("Connection")) {
          console.error("[hot-reload] poll error:", e.message);
        }
        await new Promise(res => setTimeout(res, 2000));
      }
    }
  };

  poll().catch(e => console.error("[hot-reload] loop crashed:", e.message));
  console.log("[hot-reload] agent CLAUDE.md reload listener started");
}

startAgentHotReload().catch(e => console.error("[hot-reload] start error:", e.message));

console.log(`Konoha bus listening on port ${PORT}`);
export { app };
export default {
  port: PORT,
  fetch: app.fetch,
  idleTimeout: 0, // disable Bun's 10s idle timeout — SSE streams stay open indefinitely
};
