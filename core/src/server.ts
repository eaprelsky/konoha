import { Hono } from "hono";
import { mkdirSync } from "fs";
import { startReminderScheduler, restoreReminderJobs } from "../../src/runtime";
import { redis, createRedis } from "../../src/redis";
import { getAgentDef, listAgentDefs, buildSystemPrompt } from "../../src/agent-lifecycle";
import { handleEventFired } from "../../src/runtime";
import { initTsunade } from "../../src/tsunade";
import { registerTriggerResolverRoutes } from "../../src/trigger-resolver";
import { registerEventManagerRoutes, restoreSubscriptions, startDelayWorker } from "../../src/event-manager";
import { registerWorkCalendarRoutes } from "../../src/work-calendar";
import { requireAuth } from "../../src/middleware/auth";
import type { HonoEnv } from "../../src/types";

// Route modules
import agentsRouter from "../../src/routes/agents";
import agentsAvatarRouter from "../../src/routes/agents-avatar";
import messagesRouter, { attachmentsRouter, channelsRouter } from "../../src/routes/messages";
import eventsRouter, { miningRouter } from "../../src/routes/events";
import rolesRouter from "../../src/routes/roles";
import skillsRouter from "../../src/routes/skills";
import documentsRouter from "../../src/routes/documents";
import peopleRouter from "../../src/routes/people";
import avatarsRouter from "../../src/routes/avatars";
import aiRouter from "../../src/routes/ai";
import kbRouter, { kbChatRouter } from "../../src/routes/kb";
import whitelistRouter from "../../src/routes/whitelist";
import adminRouter from "../../src/routes/admin";
import githubRouter from "../../src/routes/github";
import auditRouter from "../../src/routes/audit";
import deployRouter from "../../src/routes/deploy";
import testbenchProxyRouter from "../../src/routes/testbench-proxy";
import { seedSystemAgents } from "../../src/routes/admin";
import staticRouter, { DIST_UI_DIR } from "../../src/middleware/static";
import { actRouter } from "../../src/act-envelope";
import { registerAllHandlers } from "../../src/action-handlers";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

// Workflow-engine module
import workflowEngineModule from "../../modules/workflow-engine/src";

const ATTACHMENTS_DIR = "/opt/shared/attachments";
mkdirSync(ATTACHMENTS_DIR, { recursive: true });

// Register direct action handlers for act-envelope spine (#527)
registerAllHandlers();

// ── Env validation ────────────────────────────────────────────────────────────
// Required vars. Missing any = server refuses to start with a clear message.
const REQUIRED_ENV: Array<{ key: string; hint: string }> = [
  { key: "KONOHA_TOKEN",      hint: "Admin auth token — set a strong random value" },
  { key: "ANTHROPIC_API_KEY", hint: "Anthropic API key — get from console.anthropic.com" },
];

const missingEnv = REQUIRED_ENV.filter(({ key }) => !process.env[key]);
if (missingEnv.length > 0) {
  console.error("[startup] Missing required environment variables:");
  for (const { key, hint } of missingEnv) {
    console.error(`  ${key}  →  ${hint}`);
  }
  console.error("[startup] Set them in /home/ubuntu/.agent-env (loaded by systemd) or .env");
  process.exit(1);
}

function isFatalStartupError(message: string): boolean {
  return message.includes("Failed to start server. Is port") || message.includes("EADDRINUSE");
}

// Prevent transient ioredis disconnect errors from crashing the process,
// but let fatal startup errors fail fast so systemd can restart cleanly.
process.on("uncaughtException", (err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error("[uncaughtException]", message);
  if (isFatalStartupError(message)) process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  console.error("[unhandledRejection]", reason);
  if (isFatalStartupError(message)) process.exit(1);
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

// Mount platform routers
app.route("/agents", agentsRouter);
app.route("/agents", agentsAvatarRouter);
app.route("/messages", messagesRouter);
app.route("/attachments", attachmentsRouter);
app.route("/channels", channelsRouter);
app.route("/events", eventsRouter);
app.route("/mining", miningRouter);
app.route("/roles", rolesRouter);
app.route("/skills", skillsRouter);
app.route("/documents", documentsRouter);
app.route("/people", peopleRouter);
app.route("/", avatarsRouter);
app.route("/", aiRouter);
app.route("/kb", kbRouter);
app.route("/ai", kbChatRouter);
app.route("/whitelist", whitelistRouter);
app.route("/", githubRouter); // POST /webhooks/github — HMAC verified, no auth middleware
app.route("/", auditRouter); // GET /audit, POST /github/issues, GET|PUT /config/autonomy
app.route("/", deployRouter); // POST /deploy, GET /deploy/status, GET|PUT /config/settings
app.route("/", testbenchProxyRouter); // /testbench/* → proxy to port 3201 (closes #323)

// Register plugin routes
registerTriggerResolverRoutes(app, requireAuth);
registerEventManagerRoutes(app, requireAuth);
registerWorkCalendarRoutes(app, requireAuth);

// Mount workflow-engine module (cases, workitems, reminders, workflows)
app.route("/", workflowEngineModule);

// Unified action envelope (#500) — POST /act, GET /act, GET /act/:actionId
app.route("/act", actRouter);

// ── /api/* compatibility shim (closes #464) ──────────────────────────────────
// The frontend JS uses BASE = '/api' for all API calls.
// In production nginx strips the prefix (location /api/ { proxy_pass /; }).
// When the built UI is served directly from this process (TestBench, local dev),
// no nginx is involved so we strip the prefix ourselves by re-fetching internally.
//
// Body-reading risk: c.req.raw is forwarded as-is so the body stream is intact.
// If a future middleware consumes the body before routing reaches this handler,
// the re-fetch will receive an empty body. Avoid body-reading middleware above this.
app.all("/api/*", async (c) => {
  const url = new URL(c.req.url);
  url.pathname = url.pathname.slice("/api".length) || "/";
  return app.fetch(new Request(url.toString(), c.req.raw));
});

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

// ── Hot-reload: regenerate AGENTS.md for affected agents when workflows change ──
// Listens to `konoha:agent-reload` stream (written by workflow-loader on updateWorkflow).
// Does NOT restart agents — just rewrites their AGENTS.md so the next /new picks it up.
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
              // Regenerate AGENTS.md for all managed agents (role assignments may have changed)
              try {
                const defs = await listAgentDefs();
                for (const def of defs) {
                  const workdir = join(WORKDIR_ROOT, def.id);
                  const instructionsPath = join(workdir, "AGENTS.md");
                  if (existsSync(instructionsPath)) {
                    const instructions = await buildSystemPrompt(def.id, def);
                    writeFileSync(instructionsPath, instructions, "utf-8");
                    console.log(`[hot-reload] Regenerated AGENTS.md for agent "${def.id}" (${obj.type})`);
                  }
                }
              } catch (e: any) {
                console.error("[hot-reload] Failed to regenerate AGENTS.md:", e.message);
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
  console.log("[hot-reload] agent AGENTS.md reload listener started");
}

startAgentHotReload().catch(e => console.error("[hot-reload] start error:", e.message));

console.log(`Konoha bus listening on port ${PORT}`);
export { app };
export default {
  port: PORT,
  fetch: app.fetch,
  idleTimeout: 0, // disable Bun's 10s idle timeout — SSE streams stay open indefinitely
};
