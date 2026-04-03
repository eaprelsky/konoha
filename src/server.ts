import { randomUUID } from "crypto";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { streamSSE } from "hono/streaming";
import { mkdirSync, writeFileSync, existsSync, statSync, readFileSync, readdirSync, unlinkSync } from "fs";
import { join, extname, basename } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
const execFileAsync = promisify(execFile);
import { loadWorkflows, getWorkflow, listWorkflows, createWorkflow, updateWorkflow, archiveWorkflow, listWorkflowVersions } from "./workflow-loader";
import { normalizeElementNames } from "./normalizer";
import { createCase, getCase, getWorkItem, completeWorkItem, listWorkItems, listCases, listEvents, createStandaloneWorkItem, updateWorkItem, processEvent, createReminder, listReminders, updateReminderStatus, deleteReminder, startReminderScheduler, purgeAllWorkItems, createRole, listRoles, updateRole, deleteRole, createDoc, listDocs, updateDoc, deleteDoc, type WorkItemStatus, type CaseStatus, type ReminderStatus, type ReminderChannel, type ReminderType, type AssignmentStrategy, type DocType } from "./runtime";
import { getAdapter, listAdapters } from "./adapters/index";
import {
  registerAgent,
  unregisterAgent,
  heartbeat,
  listAgents,
  sendMessage,
  readMessages,
  readMessagesPending,
  ackMessages,
  readHistory,
  listChannels,
  createSubscriber,
  getAgentIdByToken,
  createInvite,
  consumeInvite,
  publishEvent,
  redis,
  type Attachment,
  type KonohaEvent,
} from "./redis";
import {
  createAgentDef,
  getAgentDef,
  deleteAgentDef,
  listAgentDefs,
  getAgentState,
  startAgent,
  stopAgent,
  restartAgent,
  renderSystemTemplate,
  isTmuxRunning,
} from "./agent-lifecycle";

const ATTACHMENTS_DIR = "/opt/shared/attachments";
mkdirSync(ATTACHMENTS_DIR, { recursive: true });

// Prevent ioredis disconnect errors from crashing the process
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException] swallowed:", err.message);
});
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection] swallowed:", reason);
});

const ADMIN_TOKEN = process.env.KONOHA_TOKEN || "konoha-dev-token";
const PORT = parseInt(process.env.KONOHA_PORT || "3100");

const app = new Hono();

// Resolve caller identity from Bearer token.
// Returns { isAdmin: true } for master token, or { isAdmin: false, agentId } for per-agent token.
// Returns null if token is missing or invalid.
async function resolveAuth(c: any): Promise<{ isAdmin: boolean; agentId: string | null } | null> {
  const auth = c.req.header("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;
  if (token === ADMIN_TOKEN) return { isAdmin: true, agentId: null };
  const agentId = await getAgentIdByToken(token);
  if (!agentId) return null;
  return { isAdmin: false, agentId };
}

// Middleware: require any valid auth (admin or agent token)
async function requireAuth(c: any, next: any) {
  const caller = await resolveAuth(c);
  if (!caller) return c.json({ error: "Unauthorized" }, 401);
  c.set("caller", caller);
  await next();
}

// Middleware: require admin token only
async function requireAdmin(c: any, next: any) {
  const caller = await resolveAuth(c);
  if (!caller || !caller.isAdmin) return c.json({ error: "Forbidden: admin token required" }, 403);
  c.set("caller", caller);
  await next();
}

// Apply auth to all protected routes
// /agents/register is handled inline (invite token logic, no middleware)
app.use("/agents/invite", requireAdmin);
app.use("/agents/:id/heartbeat", requireAuth);
app.use("/agents/:id/start", requireAuth);
app.use("/agents/:id/stop", requireAuth);
app.use("/agents/:id/restart", requireAuth);
app.use("/agents/:id/status", requireAuth);
app.use("/agents/:id", (c, next) => {
  // /agents/register has its own auth — skip middleware for it
  if (c.req.path === "/agents/register") return next();
  return requireAuth(c, next);
});
app.use("/agents", requireAuth);
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

// health
app.get("/health", (c) => c.json({ status: "ok", ts: new Date().toISOString() }));

// --- Static UI files (no auth required) ---
// Serve from dist/ui/ (React build output) with fallback to public/ (vanilla HTML)
const DIST_UI_DIR  = join(import.meta.dir, "..", "dist", "ui");
const PUBLIC_DIR   = join(import.meta.dir, "..", "public");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".ico":  "image/x-icon",
};
app.get("/ui", (c) => c.redirect("/ui/index.html"));
app.get("/ui/:file{.+}", (c) => {
  const name = c.req.param("file");
  if (name.includes("..")) return c.text("Forbidden", 403);
  const ext  = extname(name).toLowerCase();
  const mime = MIME[ext] || "application/octet-stream";
  // Prefer built React output; fall back to vanilla public/
  for (const base of [DIST_UI_DIR, PUBLIC_DIR]) {
    const filePath = join(base, name);
    if (existsSync(filePath) && statSync(filePath).isFile()) {
      return c.body(readFileSync(filePath), 200, { "content-type": mime });
    }
  }
  return c.text("Not found", 404);
});

// --- Agents ---

// Issue a one-time invite token (admin only)
app.post("/agents/invite", async (c) => {
  const invite = await createInvite();
  return c.json(invite, 201);
});

// Register: requires admin token OR a valid (one-time) invite token
app.post("/agents/register", async (c) => {
  const auth = c.req.header("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return c.json({ error: "Unauthorized" }, 401);

  const isAdmin = token === ADMIN_TOKEN;
  if (!isAdmin) {
    // Try invite token
    const valid = await consumeInvite(token);
    if (!valid) return c.json({ error: "Unauthorized: invalid or expired invite token" }, 401);
  }

  const body = await c.req.json();
  const { id, name, capabilities = [], roles = [], model, eventSubscriptions, village_id } = body;
  if (!id || !name) return c.json({ error: "id and name required" }, 400);
  const agent = await registerAgent({ id, name, capabilities, roles, ...(model ? { model } : {}), ...(eventSubscriptions ? { eventSubscriptions } : {}), ...(village_id ? { village_id } : {}) });
  return c.json(agent, 201);
});

// --- Agent lifecycle management (create/start/stop/restart/status/delete) ---

// POST /agents — create a managed agent definition
app.post("/agents", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { id, name, system_prompt, model = "claude-sonnet-4-6", env, tags } = body;
  if (!id || !name) return c.json({ error: "id and name required" }, 400);
  const def = await createAgentDef({ id, name, system_prompt, model, env, tags });
  // Prepare personal memory directory
  mkdirSync(`/opt/shared/agent-memory/${id}`, { recursive: true });
  return c.json(def, 201);
});

// GET /agents/:id/status — lifecycle status (tmux state, pid, uptime)
app.get("/agents/:id/status", async (c) => {
  const id = c.req.param("id");
  const def = await getAgentDef(id);
  if (!def) return c.json({ error: "Agent not found" }, 404);
  const state = await getAgentState(id);
  return c.json(state);
});

// POST /agents/:id/start
app.post("/agents/:id/start", async (c) => {
  const id = c.req.param("id");
  const def = await getAgentDef(id);
  if (!def) return c.json({ error: "Agent not found" }, 404);
  try {
    const state = await startAgent(id, def);
    return c.json(state);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// POST /agents/:id/stop
app.post("/agents/:id/stop", async (c) => {
  const id = c.req.param("id");
  const def = await getAgentDef(id);
  if (!def) return c.json({ error: "Agent not found" }, 404);
  try {
    const state = await stopAgent(id);
    return c.json(state);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// POST /agents/:id/restart
app.post("/agents/:id/restart", async (c) => {
  const id = c.req.param("id");
  const def = await getAgentDef(id);
  if (!def) return c.json({ error: "Agent not found" }, 404);
  try {
    const state = await restartAgent(id, def);
    return c.json(state);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// GET /agents/tmux/:id — capture tmux pane output (last 200 lines)
app.use("/agents/tmux/:id", requireAuth);
app.get("/agents/tmux/:id", async (c) => {
  const id = c.req.param("id");
  const konohaSession = `konoha-${id}`;

  async function capturePane(args: string[]): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync("tmux", [...args, "-S", "-200"]);
      return stdout;
    } catch { return null; }
  }

  // Attempt 1: konoha lifecycle session (default socket)
  const lines1 = await capturePane(["capture-pane", "-p", "-t", konohaSession]);
  if (lines1 !== null) return c.json({ session: konohaSession, lines: lines1 });

  // Attempt 2: system agent session (named socket, e.g. naruto/sasuke/kakashi)
  const lines2 = await capturePane(["-L", id, "capture-pane", "-p", "-t", id]);
  if (lines2 !== null) return c.json({ session: id, lines: lines2 });

  return c.json({ session: konohaSession, lines: "" });
});

// GET /agents/:id/system-template — rendered system template for this agent
app.get("/agents/:id/system-template", async (c) => {
  const id = c.req.param("id");
  const def = await getAgentDef(id);
  const base = def ?? { id, name: id, model: "claude-sonnet-4-6" };
  return c.json({ template: renderSystemTemplate(base) });
});

// GET /agents/:id/memory — list memory files for agent
app.get("/agents/:id/memory", requireAuth, async (c) => {
  const id = c.req.param("id");
  const dir = `/opt/shared/agent-memory/${basename(id)}`;
  if (!existsSync(dir)) return c.json([]);
  const files = readdirSync(dir)
    .filter(f => !f.startsWith("."))
    .map(f => {
      const st = statSync(join(dir, f));
      return { name: f, size: st.size, updated_at: st.mtime.toISOString() };
    })
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return c.json(files);
});

// GET /agents/:id/memory/:filename — read one memory file
app.get("/agents/:id/memory/:filename", requireAuth, async (c) => {
  const id = c.req.param("id");
  const filename = basename(c.req.param("filename")); // prevent path traversal
  const dir = `/opt/shared/agent-memory/${basename(id)}`;
  const filepath = join(dir, filename);
  if (!existsSync(filepath)) return c.json({ error: "Not found" }, 404);
  const content = readFileSync(filepath, "utf-8");
  return c.text(content);
});

// DELETE /agents/:id/memory/:filename — delete one memory file
app.delete("/agents/:id/memory/:filename", requireAuth, async (c) => {
  const id = c.req.param("id");
  const filename = basename(c.req.param("filename")); // prevent path traversal
  const dir = `/opt/shared/agent-memory/${basename(id)}`;
  const filepath = join(dir, filename);
  if (!existsSync(filepath)) return c.json({ error: "Not found" }, 404);
  unlinkSync(filepath);
  return c.json({ ok: true });
});

// PUT /agents/:id/memory/:filename — overwrite memory file content
app.put("/agents/:id/memory/:filename", requireAuth, async (c) => {
  const id = c.req.param("id");
  const filename = basename(c.req.param("filename"));
  if (!filename.endsWith(".md") && !filename.endsWith(".txt") && !filename.endsWith(".json")) {
    return c.json({ error: "Only .md, .txt, .json files allowed" }, 415);
  }
  const dir = `/opt/shared/agent-memory/${basename(id)}`;
  const filepath = join(dir, filename);
  if (!existsSync(filepath)) return c.json({ error: "Not found" }, 404);
  const content = await c.req.text();
  writeFileSync(filepath, content, "utf-8");
  return c.json({ ok: true, filename, size: content.length });
});

// POST /agents/:id/memory/:filename — create new memory file
app.post("/agents/:id/memory/:filename", requireAuth, async (c) => {
  const id = c.req.param("id");
  const filename = basename(c.req.param("filename"));
  if (!filename.endsWith(".md") && !filename.endsWith(".txt") && !filename.endsWith(".json")) {
    return c.json({ error: "Only .md, .txt, .json files allowed" }, 415);
  }
  const dir = `/opt/shared/agent-memory/${basename(id)}`;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const filepath = join(dir, filename);
  if (existsSync(filepath)) return c.json({ error: "File already exists, use PUT to update" }, 409);
  const content = await c.req.text().catch(() => "");
  writeFileSync(filepath, content, "utf-8");
  return c.json({ ok: true, filename, size: content.length }, 201);
});

// GET /agents/:id — get single agent (bus data merged with def)
app.get("/agents/:id", async (c) => {
  const id = c.req.param("id");
  const [busAgents, def] = await Promise.all([
    listAgents(false),
    getAgentDef(id),
  ]);
  const busAgent = busAgents.find(a => a.id === id);
  if (!busAgent && !def) return c.json({ error: "Agent not found" }, 404);
  const base = busAgent ?? { id, status: "offline" };
  if (!def) return c.json(base);
  const state = await getAgentState(id);
  return c.json({ ...base, ...def, lifecycle: { status: state.status, pid: state.pid, uptime_seconds: state.uptime_seconds } });
});

// PUT /agents/:id — update agent definition fields (name, system_prompt, model)
app.put("/agents/:id", async (c) => {
  const id = c.req.param("id");
  const def = await getAgentDef(id);
  if (!def) return c.json({ error: "Agent not found or not managed" }, 404);
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON" }, 400);
  const updated = { ...def, ...body, id, updated_at: new Date().toISOString() };
  await redis.hset("konoha:agent:defs", id, JSON.stringify(updated));
  return c.json(updated);
});

// DELETE /agents/:id — stop agent, delete definition, and unregister from bus
app.delete("/agents/:id", async (c) => {
  const id = c.req.param("id");
  const def = await getAgentDef(id);
  if (def?.protected) return c.json({ error: "Cannot delete a protected system agent" }, 403);
  if (def) {
    // Stop if running
    const state = await getAgentState(id);
    if (state.status === "running" || state.status === "starting") {
      await stopAgent(id).catch(() => {});
    }
    await deleteAgentDef(id);
  } else {
    // Legacy: unregister from bus only
    const hard = c.req.query("hard") === "true";
    await unregisterAgent(id, hard);
  }
  return c.json({ ok: true });
});

// GET /agents — list with lifecycle status merged in
app.get("/agents", async (c) => {
  const onlineOnly = c.req.query("online") === "true";
  const [busAgents, defs] = await Promise.all([
    listAgents(onlineOnly),
    listAgentDefs(),
  ]);
  // Build a map from managed defs for quick lookup
  const defMap = new Map(defs.map(d => [d.id, d]));
  async function lifecycleForDef(id: string, def: { protected?: boolean; tmux_session_override?: string }) {
    if (def.tmux_session_override) {
      const running = await isTmuxRunning(def.tmux_session_override);
      return { status: running ? "running" : "stopped" };
    }
    const state = await getAgentState(id);
    return { status: state.status, pid: state.pid, uptime_seconds: state.uptime_seconds };
  }

  // Merge lifecycle state into bus agents
  const agentsWithState = await Promise.all(
    busAgents.map(async (a) => {
      const def = defMap.get(a.id);
      if (!def) return a;
      const lifecycle = await lifecycleForDef(a.id, def);
      return { ...a, ...def, lifecycle };
    })
  );
  // Also include managed agents not yet on the bus
  const busIds = new Set(busAgents.map(a => a.id));
  const unmatchedDefs = defs.filter(d => !busIds.has(d.id));
  const unmatchedWithState = await Promise.all(
    unmatchedDefs.map(async (d) => {
      const lifecycle = await lifecycleForDef(d.id, d);
      return { ...d, status: "offline", lifecycle };
    })
  );
  return c.json([...agentsWithState, ...unmatchedWithState]);
});

app.post("/agents/:id/heartbeat", async (c) => {
  const id = c.req.param("id");
  const caller: { isAdmin: boolean; agentId: string | null } = c.get("caller");
  if (!caller.isAdmin && caller.agentId !== id) {
    return c.json({ error: "Forbidden: can only send heartbeat for yourself" }, 403);
  }
  await heartbeat(id);
  return c.json({ ok: true });
});

// --- Messages ---

app.post("/messages", async (c) => {
  const body = await c.req.json();
  const { to, type = "message", text, channel, replyTo, attachments, village_id } = body;
  const caller: { isAdmin: boolean; agentId: string | null } = c.get("caller");

  // Determine sender: admin can specify from, agent token sets from automatically
  const from: string = caller.isAdmin ? (body.from || "admin") : caller.agentId!;
  if (!from || !to || !text) return c.json({ error: "from, to, text required" }, 400);
  // validate attachment paths exist
  const validAttachments: Attachment[] = [];
  if (Array.isArray(attachments)) {
    for (const att of attachments) {
      if (att.path && existsSync(att.path)) {
        const st = statSync(att.path);
        validAttachments.push({
          name: att.name || att.path.split("/").pop() || "file",
          path: att.path,
          mime: att.mime,
          size: att.size || st.size,
        });
      }
    }
  }
  const id = await sendMessage({ from, to, type, text, channel, replyTo, attachments: validAttachments.length > 0 ? validAttachments : undefined, ...(village_id ? { village_id } : {}) });
  return c.json({ id });
});

// --- File Upload ---

app.post("/attachments", async (c) => {
  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  const from = formData.get("from") as string | null;
  if (!file || !from) return c.json({ error: "file and from required" }, 400);

  const ts = Date.now();
  const ext = extname(file.name) || "";
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const storedName = `${from}-${ts}${ext ? ext : ""}`;
  const storedPath = join(ATTACHMENTS_DIR, storedName);

  const buf = Buffer.from(await file.arrayBuffer());
  writeFileSync(storedPath, buf);

  const attachment: Attachment = {
    name: file.name,
    path: storedPath,
    mime: file.type || undefined,
    size: buf.length,
  };

  return c.json({ attachment }, 201);
});

app.get("/messages/:agentId", async (c) => {
  const agentId = c.req.param("agentId");
  const caller: { isAdmin: boolean; agentId: string | null } = c.get("caller");
  // Non-admin agents can only read their own inbox
  if (!caller.isAdmin && caller.agentId !== agentId) {
    return c.json({ error: "Forbidden: can only read your own inbox" }, 403);
  }
  const count = parseInt(c.req.query("count") || "10");
  // Optional consumer param for fan-out: each consumer sees all messages independently
  const consumer = c.req.query("consumer") || undefined;
  const messages = await readMessages(agentId, count, consumer);
  return c.json(messages);
});

// GET pending messages without auto-ack (requires ?consumer=xxx)
app.get("/messages/:agentId/pending", async (c) => {
  const agentId = c.req.param("agentId");
  const caller: { isAdmin: boolean; agentId: string | null } = c.get("caller");
  if (!caller.isAdmin && caller.agentId !== agentId) {
    return c.json({ error: "Forbidden: can only read your own inbox" }, 403);
  }
  const consumer = c.req.query("consumer");
  if (!consumer) return c.json({ error: "consumer query param required" }, 400);
  const count = parseInt(c.req.query("count") || "10");
  const messages = await readMessagesPending(agentId, consumer, count);
  return c.json(messages);
});

// POST ack: acknowledge specific message IDs for a consumer
app.post("/messages/:agentId/ack", async (c) => {
  const agentId = c.req.param("agentId");
  const caller: { isAdmin: boolean; agentId: string | null } = c.get("caller");
  if (!caller.isAdmin && caller.agentId !== agentId) {
    return c.json({ error: "Forbidden: can only ack your own messages" }, 403);
  }
  const body = await c.req.json();
  const { consumer, ids } = body;
  if (!consumer || !Array.isArray(ids) || ids.length === 0) {
    return c.json({ error: "consumer and ids[] required" }, 400);
  }
  const acked = await ackMessages(agentId, consumer, ids);
  return c.json({ acked });
});

app.get("/messages/:agentId/history", async (c) => {
  const agentId = c.req.param("agentId");
  const count = parseInt(c.req.query("count") || "20");
  const messages = await readHistory(agentId, count);
  return c.json(messages);
});

// --- SSE Stream ---

app.get("/messages/:agentId/stream", async (c) => {
  const agentId = c.req.param("agentId");
  return streamSSE(c, async (stream) => {
    // Send immediate ping so client knows stream is live
    try { await stream.writeSSE({ event: "ping", data: "" }); } catch {}

    const sub = createSubscriber(agentId, (msg) => {
      try {
        stream.writeSSE({ event: "message", data: JSON.stringify(msg) });
      } catch { sub.close(); }
    });

    const keepAlive = setInterval(() => {
      try { stream.writeSSE({ event: "ping", data: "" }); }
      catch { clearInterval(keepAlive); sub.close(); }
    }, 30000);

    stream.onAbort(() => {
      clearInterval(keepAlive);
      sub.close();
    });

    await new Promise(() => {});
  });
});

// --- Events ---

app.post("/events", async (c) => {
  const body = await c.req.json();
  const { type, source, payload, timestamp, village_id } = body;

  if (!type || typeof type !== "string") return c.json({ error: "type is required and must be a string" }, 400);
  if (!source || typeof source !== "string") return c.json({ error: "source is required and must be a string" }, 400);
  if (payload === undefined || typeof payload !== "object" || Array.isArray(payload)) return c.json({ error: "payload is required and must be an object" }, 400);
  if (!village_id || typeof village_id !== "string") return c.json({ error: "village_id is required and must be a string" }, 400);

  const event: KonohaEvent = {
    type,
    source,
    payload,
    timestamp: timestamp || new Date().toISOString(),
    village_id,
  };

  const id = await publishEvent(event);

  // Trigger workflow runtime: find matching process definitions and create cases
  const cases = await processEvent(type, source, payload).catch((e) => {
    console.error("[runtime] processEvent error:", e.message);
    return [];
  });

  return c.json({ id, cases_created: cases.map(c => c.case_id) });
});

app.get("/events/log", async (c) => {
  const type = c.req.query("type") || undefined;
  const after = c.req.query("after") || undefined;
  const before = c.req.query("before") || undefined;
  const limit = Math.min(parseInt(c.req.query("limit") || "100"), 1000);
  const events = await listEvents({ type, after, before, limit });
  return c.json(events);
});

// --- Cases & Work Items (Workflow Runtime) ---

app.get("/cases", async (c) => {
  const status = (c.req.query("status") || undefined) as CaseStatus | undefined;
  const process_id = c.req.query("process_id") || undefined;
  const after = c.req.query("after") || undefined;
  const before = c.req.query("before") || undefined;
  const limit = Math.min(parseInt(c.req.query("limit") || "50"), 200);
  const offset = parseInt(c.req.query("offset") || "0");
  const result = await listCases({ status, process_id, after, before, limit, offset });
  return c.json(result);
});

app.post("/cases", async (c) => {
  const body = await c.req.json();
  const { process_id, subject, payload = {}, start_node } = body;
  if (!process_id || !subject) return c.json({ error: "process_id and subject required" }, 400);
  try {
    const kase = await createCase(process_id, subject, payload, start_node);
    return c.json(kase, 201);
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

app.get("/cases/:id", async (c) => {
  const id = c.req.param("id");
  const kase = await getCase(id);
  if (!kase) return c.json({ error: "Case not found" }, 404);
  return c.json(kase);
});

app.post("/workitems/:id/complete", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const output = body.output || {};
  try {
    const result = await completeWorkItem(id, output);
    return c.json(result);
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

app.get("/workitems", async (c) => {
  const assignee = c.req.query("assignee") || undefined;
  const status = (c.req.query("status") || undefined) as WorkItemStatus | undefined;
  const process_id = c.req.query("process_id") || undefined;
  const deadline_before = c.req.query("deadline_before") || undefined;
  const items = await listWorkItems({ assignee, status, process_id, deadline_before });
  return c.json(items);
});

app.post("/workitems", async (c) => {
  const body = await c.req.json();
  const { label, assignee, input = {}, deadline } = body;
  if (!label || !assignee) return c.json({ error: "label and assignee required" }, 400);
  const wi = await createStandaloneWorkItem({ label, assignee, input, deadline });
  return c.json(wi, 201);
});

app.patch("/workitems/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const { status, assignee, deadline, output, label } = body;
  try {
    const wi = await updateWorkItem(id, { status, assignee, deadline, output, label });
    return c.json(wi);
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

app.delete("/workitems/all", requireAuth, async (c) => {
  const deleted = await purgeAllWorkItems();
  return c.json({ ok: true, deleted });
});

app.delete("/workitems/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const wi = await updateWorkItem(id, { status: "cancelled" });
    return c.json(wi);
  } catch (e: any) {
    return c.json({ error: e.message }, 404);
  }
});

// --- Reminders ---

app.use("/reminders/*", requireAuth);
app.use("/reminders", requireAuth);

app.get("/reminders", async (c) => {
  const status = (c.req.query("status") || undefined) as ReminderStatus | undefined;
  const recipient = c.req.query("recipient") || undefined;
  const reminders = await listReminders({ status, recipient });
  return c.json(reminders);
});

app.post("/reminders", async (c) => {
  const body = await c.req.json();
  const { type, recipient, message, scheduled_at, channel, case_id, process_id, element_id } = body;
  if (!recipient || !message || !scheduled_at) {
    return c.json({ error: "recipient, message and scheduled_at required" }, 400);
  }
  const r = await createReminder({
    type: (type || "standalone") as ReminderType,
    recipient,
    message,
    scheduled_at,
    channel: (channel || "gui") as ReminderChannel,
    case_id,
    process_id,
    element_id,
  });
  return c.json(r, 201);
});

app.patch("/reminders/:id/status", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const { status } = body;
  if (!status) return c.json({ error: "status required" }, 400);
  try {
    const r = await updateReminderStatus(id, status as ReminderStatus);
    return c.json(r);
  } catch (e: any) {
    return c.json({ error: e.message }, 404);
  }
});

app.delete("/reminders/:id", async (c) => {
  const id = c.req.param("id");
  try {
    await deleteReminder(id);
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 404);
  }
});

// --- Roles Directory ---

app.use("/roles/*", requireAuth);
app.use("/roles", requireAuth);

app.get("/roles", async (c) => {
  return c.json(await listRoles());
});
app.post("/roles", async (c) => {
  const body = await c.req.json();
  const { role_id, name, description, assignees = [], strategy = "manual" } = body;
  if (!role_id || !name) return c.json({ error: "role_id and name required" }, 400);
  const r = await createRole({ role_id, name, description, assignees, strategy: strategy as AssignmentStrategy });
  return c.json(r, 201);
});
app.patch("/roles/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  try { return c.json(await updateRole(id, body)); }
  catch (e: any) { return c.json({ error: e.message }, 404); }
});
app.delete("/roles/:id", async (c) => {
  const id = c.req.param("id");
  try { await deleteRole(id); return c.json({ ok: true }); }
  catch (e: any) { return c.json({ error: e.message }, 404); }
});

// --- Skills / Capabilities ---

const SKILL_KEY_PREFIX = "konoha:skill:";
const SKILLS_IDX_ALL   = "konoha:skills:all";

type SkillRecord = {
  id: string; name: string; name_en?: string; description?: string;
  prompt_snippet?: string; tools?: string[];
  created_at: string; updated_at: string;
};

app.use("/skills/*", requireAuth);
app.use("/skills", requireAuth);

app.get("/skills", async (c) => {
  const ids = await redis.zrange(SKILLS_IDX_ALL, 0, -1);
  const raws = await Promise.all(ids.map(id => redis.get(SKILL_KEY_PREFIX + id)));
  return c.json(raws.filter(Boolean).map(r => JSON.parse(r!)));
});

app.post("/skills", async (c) => {
  const body = await c.req.json<Partial<SkillRecord>>();
  if (!body.name?.trim()) return c.json({ error: "name required" }, 400);
  const id = body.id?.trim() || body.name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  const now = new Date().toISOString();
  const skill: SkillRecord = {
    id, name: body.name.trim(),
    name_en: body.name_en?.trim() || undefined,
    description: body.description?.trim() || undefined,
    prompt_snippet: body.prompt_snippet?.trim() || undefined,
    tools: Array.isArray(body.tools) ? body.tools : undefined,
    created_at: now, updated_at: now,
  };
  await redis.set(SKILL_KEY_PREFIX + id, JSON.stringify(skill));
  await redis.zadd(SKILLS_IDX_ALL, new Date(now).getTime(), id);
  return c.json(skill, 201);
});

app.patch("/skills/:id", async (c) => {
  const id = c.req.param("id");
  const raw = await redis.get(SKILL_KEY_PREFIX + id);
  if (!raw) return c.json({ error: "Skill not found" }, 404);
  const skill: SkillRecord = JSON.parse(raw);
  const body = await c.req.json<Partial<SkillRecord>>().catch(() => ({}));
  if (body.name !== undefined)           skill.name = body.name.trim();
  if (body.name_en !== undefined)        skill.name_en = body.name_en?.trim() || undefined;
  if (body.description !== undefined)    skill.description = body.description?.trim() || undefined;
  if (body.prompt_snippet !== undefined) skill.prompt_snippet = body.prompt_snippet?.trim() || undefined;
  if (body.tools !== undefined)          skill.tools = Array.isArray(body.tools) ? body.tools : undefined;
  skill.updated_at = new Date().toISOString();
  await redis.set(SKILL_KEY_PREFIX + id, JSON.stringify(skill));
  return c.json(skill);
});

app.delete("/skills/:id", async (c) => {
  const id = c.req.param("id");
  await redis.del(SKILL_KEY_PREFIX + id);
  await redis.zrem(SKILLS_IDX_ALL, id);
  return c.json({ ok: true });
});

// --- Documents Directory ---

app.use("/documents/*", requireAuth);
app.use("/documents", requireAuth);

app.get("/documents", async (c) => {
  return c.json(await listDocs());
});
app.post("/documents", async (c) => {
  const body = await c.req.json();
  const { name, type = "template", content = "" } = body;
  if (!name) return c.json({ error: "name required" }, 400);
  return c.json(await createDoc({ name, type: type as DocType, content }), 201);
});
app.patch("/documents/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  try { return c.json(await updateDoc(id, body)); }
  catch (e: any) { return c.json({ error: e.message }, 404); }
});
app.delete("/documents/:id", async (c) => {
  const id = c.req.param("id");
  try { await deleteDoc(id); return c.json({ ok: true }); }
  catch (e: any) { return c.json({ error: e.message }, 404); }
});

// --- Adapters ---

app.get("/adapters", async (c) => {
  return c.json({ adapters: listAdapters() });
});

app.get("/adapters/:name/health", async (c) => {
  const name = c.req.param("name");
  const adapter = getAdapter(name);
  if (!adapter) return c.json({ error: "Adapter not found" }, 404);
  const healthy = await adapter.healthcheck().catch(() => false);
  return c.json({ adapter: name, healthy }, healthy ? 200 : 503);
});

// --- People Directory ---

const PEOPLE_CUSTOM_KEY = "people:custom";
const PEOPLE_AVATARS_KEY = "people:avatars";

type PersonRecord = {
  id: string; name: string; tg_id: number; position: string;
  tg_username?: string; email?: string; source?: "file" | "custom";
  bitrix24_id?: string; tracker_login?: string; yonote_id?: string;
  channel?: "telegram" | "email";
  capabilities?: string[];  // skill IDs
  avatar_url?: string;
};

function loadTrustedPeople(): PersonRecord[] {
  const TRUSTED_PATH = "/opt/shared/.trusted-users.json";
  try {
    if (!existsSync(TRUSTED_PATH)) return [];
    const raw = readFileSync(TRUSTED_PATH, "utf-8");
    const data = JSON.parse(raw) as {
      owner?: { name: string; telegram_id: number; username?: string };
      trusted?: { name: string; telegram_id: number; username?: string | null; position?: string }[];
    };
    const toId = (name: string, username?: string | null) =>
      username ? `@${username}` : name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    const people: PersonRecord[] = [];
    if (data.owner) {
      people.push({ id: toId(data.owner.name, data.owner.username), name: data.owner.name, tg_id: data.owner.telegram_id, position: "Owner", tg_username: data.owner.username || undefined, source: "file" });
    }
    for (const u of data.trusted || []) {
      people.push({ id: toId(u.name, u.username), name: u.name, tg_id: u.telegram_id, position: u.position || "", tg_username: u.username || undefined, source: "file" });
    }
    return people;
  } catch {
    return [];
  }
}

app.use("/people", requireAuth);
app.get("/people", async (c) => {
  const trusted = loadTrustedPeople();
  const map = new Map<string, PersonRecord>(trusted.map(p => [p.id, p]));
  try {
    const custom = await redis.hgetall(PEOPLE_CUSTOM_KEY);
    for (const val of Object.values(custom)) {
      const p: PersonRecord = JSON.parse(val);
      map.set(p.id, { ...p, source: "custom" });
    }
    // Merge avatars for file-based people
    const avatars = await redis.hgetall(PEOPLE_AVATARS_KEY);
    for (const [id, avatar_url] of Object.entries(avatars)) {
      const existing = map.get(id);
      if (existing && !existing.avatar_url) {
        map.set(id, { ...existing, avatar_url });
      }
    }
  } catch { /* redis unavailable — serve trusted only */ }
  return c.json([...map.values()]);
});

app.post("/people", async (c) => {
  const body = await c.req.json<Partial<PersonRecord>>();
  if (!body.name?.trim()) return c.json({ error: "name required" }, 400);
  const id = body.id?.trim() || body.name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9@.-]/g, "");
  const record: PersonRecord = {
    id,
    name: body.name.trim(),
    tg_id: body.tg_id ?? 0,
    position: body.position?.trim() || "",
    tg_username: body.tg_username?.trim() || undefined,
    email: body.email?.trim() || undefined,
    source: "custom",
    bitrix24_id: body.bitrix24_id?.trim() || undefined,
    tracker_login: body.tracker_login?.trim() || undefined,
    yonote_id: body.yonote_id?.trim() || undefined,
    channel: (body.channel === "telegram" || body.channel === "email") ? body.channel : undefined,
    capabilities: Array.isArray(body.capabilities) ? body.capabilities : undefined,
  };
  await redis.hset(PEOPLE_CUSTOM_KEY, id, JSON.stringify(record));
  return c.json(record, 201);
});

app.delete("/people/:id", requireAuth, async (c) => {
  const id = c.req.param("id");
  const trusted = loadTrustedPeople();
  if (trusted.some(p => p.id === id)) {
    return c.json({ error: "Cannot delete file-based users" }, 403);
  }
  const deleted = await redis.hdel(PEOPLE_CUSTOM_KEY, id);
  if (!deleted) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// --- Process Mining ---

app.use("/mining/*", requireAuth);

app.get("/mining/process/:id", async (c) => {
  const process_id = c.req.param("id");

  // Load workflow definition for designed elements and edges
  const wf = await getWorkflow(process_id).catch(() => null);
  const designedElements = new Set<string>(wf?.elements.map(e => e.id) || []);
  const designedEdges = new Set<string>((wf?.flow || []).map(([f, t]) => `${f}:${t}`));

  // Load all cases for this process
  const { cases } = await listCases({ process_id, limit: 1000 });

  // Per-element stats
  const elementVisits: Record<string, number> = {};
  const edgeCounts: Record<string, number> = {};

  for (const kase of cases) {
    const history = kase.history;
    for (const entry of history) {
      elementVisits[entry.element_id] = (elementVisits[entry.element_id] || 0) + 1;
    }
    // Edge traversal from consecutive history entries
    for (let i = 0; i < history.length - 1; i++) {
      const edgeKey = `${history[i].element_id}:${history[i + 1].element_id}`;
      edgeCounts[edgeKey] = (edgeCounts[edgeKey] || 0) + 1;
    }
  }

  // Load work items for duration analysis
  const workItems = await listWorkItems({ process_id });
  const durationsByElement: Record<string, number[]> = {};
  for (const wi of workItems) {
    if (!wi.element_id || wi.status !== "done") continue;
    const ms = new Date(wi.updated_at).getTime() - new Date(wi.created_at).getTime();
    if (ms < 0) continue;
    if (!durationsByElement[wi.element_id]) durationsByElement[wi.element_id] = [];
    durationsByElement[wi.element_id].push(ms);
  }

  function median(arr: number[]): number | null {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
  }
  function avg(arr: number[]): number | null {
    if (!arr.length) return null;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  // Build per-element result
  const allElementIds = new Set([...designedElements, ...Object.keys(elementVisits)]);
  const elementStats: Record<string, {
    label: string; type: string;
    visit_count: number;
    avg_duration_ms: number | null;
    max_duration_ms: number | null;
    p50_duration_ms: number | null;
  }> = {};

  for (const id of allElementIds) {
    const el = wf?.elements.find(e => e.id === id);
    const durations = durationsByElement[id] || [];
    elementStats[id] = {
      label: el?.label || id,
      type: el?.type || "unknown",
      visit_count: elementVisits[id] || 0,
      avg_duration_ms: avg(durations),
      max_duration_ms: durations.length ? Math.max(...durations) : null,
      p50_duration_ms: median(durations),
    };
  }

  // Bottleneck: highest avg_duration among function elements with data
  let bottleneckId: string | null = null;
  let maxAvg = -1;
  for (const [id, stat] of Object.entries(elementStats)) {
    if (stat.avg_duration_ms !== null && stat.avg_duration_ms > maxAvg) {
      maxAvg = stat.avg_duration_ms;
      bottleneckId = id;
    }
  }

  // Deviation: visited elements not in designed schema
  const deviationElements = Object.keys(elementVisits).filter(id => !designedElements.has(id));
  // Skipped: designed elements never visited across all cases
  const skippedElements = [...designedElements].filter(id => !elementVisits[id]);

  // Build edge result
  const allEdgeKeys = new Set([...designedEdges, ...Object.keys(edgeCounts)]);
  const edges: Record<string, { count: number; is_designed: boolean }> = {};
  for (const key of allEdgeKeys) {
    edges[key] = {
      count: edgeCounts[key] || 0,
      is_designed: designedEdges.has(key),
    };
  }

  return c.json({
    process_id,
    case_count: cases.length,
    elements: elementStats,
    edges,
    bottleneck_element_id: bottleneckId,
    deviation_elements: deviationElements,
    skipped_elements: skippedElements,
  });
});

app.get("/mining/case/:id", async (c) => {
  const case_id = c.req.param("id");
  const kase = await getCase(case_id);
  if (!kase) return c.json({ error: "Case not found" }, 404);

  // Enrich history with work item durations
  const enriched = await Promise.all(kase.history.map(async entry => {
    if (!entry.work_item_id) return { ...entry, duration_ms: null };
    const wi = await getWorkItem(entry.work_item_id);
    const duration_ms = wi && wi.status === "done"
      ? new Date(wi.updated_at).getTime() - new Date(wi.created_at).getTime()
      : null;
    return { ...entry, duration_ms };
  }));

  return c.json({
    case_id,
    process_id: kase.process_id,
    status: kase.status,
    created_at: kase.created_at,
    history: enriched,
  });
});

// --- Avatar Generation ---

import { generateAvatar } from "./adapters/image";

app.post("/agents/:id/avatar", requireAuth, async (c) => {
  const id = c.req.param("id");
  const def = await getAgentDef(id);
  if (!def) return c.json({ error: "Agent not found" }, 404);
  const contentType = c.req.header("content-type") || "";

  if (contentType.includes("multipart/form-data")) {
    const formData = await c.req.formData();
    const file = formData.get("file") as File | null;
    if (!file) return c.json({ error: "file required" }, 400);
    const ext = extname(file.name).toLowerCase();
    if (![".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext)) {
      return c.json({ error: "Only jpg/png/gif/webp allowed" }, 415);
    }
    const filename = `agent_${id.replace(/[^a-zA-Z0-9@.-]/g, "_")}_${Date.now()}${ext}`;
    const buf = Buffer.from(await file.arrayBuffer());
    writeFileSync(join(AVATARS_DIR, filename), buf);
    const avatar_url = `/api/avatars/${filename}`;
    const updated = { ...def, avatar_url, updated_at: new Date().toISOString() };
    await redis.hset("konoha:agent-defs", id, JSON.stringify(updated));
    return c.json({ avatar_url });
  }

  const body = await c.req.json<{ style?: string; description?: string }>().catch(() => ({}));
  try {
    const result = await generateAvatar({
      id,
      name: def.name,
      description: body.description || def.system_prompt?.slice(0, 100),
      style: body.style,
    });
    const updated = { ...def, avatar_url: result.avatar_url, updated_at: new Date().toISOString() };
    await redis.hset("konoha:agent-defs", id, JSON.stringify(updated));
    return c.json({ avatar_url: result.avatar_url });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

app.post("/people/:id/avatar", requireAuth, async (c) => {
  const id = c.req.param("id");
  const contentType = c.req.header("content-type") || "";

  // Resolve person (custom or file-based)
  const rawCustom = await redis.hget(PEOPLE_CUSTOM_KEY, id).catch(() => null);
  const trustedPeople = loadTrustedPeople();
  const trustedPerson = trustedPeople.find(p => p.id === id);
  const person: PersonRecord | null = rawCustom ? JSON.parse(rawCustom) : (trustedPerson || null);
  if (!person) return c.json({ error: "Person not found" }, 404);
  const isFileBased = !rawCustom;

  if (contentType.includes("multipart/form-data")) {
    // File upload path
    const formData = await c.req.formData();
    const file = formData.get("file") as File | null;
    if (!file) return c.json({ error: "file required" }, 400);
    const ext = extname(file.name).toLowerCase();
    if (![".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext)) {
      return c.json({ error: "Only jpg/png/gif/webp allowed" }, 415);
    }
    const filename = `${id.replace(/[^a-zA-Z0-9@.-]/g, "_")}_${Date.now()}${ext}`;
    const buf = Buffer.from(await file.arrayBuffer());
    writeFileSync(join(AVATARS_DIR, filename), buf);
    const avatar_url = `/api/avatars/${filename}`;
    if (isFileBased) {
      await redis.hset(PEOPLE_AVATARS_KEY, id, avatar_url);
    } else {
      (person as PersonRecord).avatar_url = avatar_url;
      await redis.hset(PEOPLE_CUSTOM_KEY, id, JSON.stringify(person));
    }
    return c.json({ avatar_url });
  }

  // Sai generation path
  const body = await c.req.json<{ style?: string; description?: string }>().catch(() => ({}));
  try {
    const result = await generateAvatar({
      id,
      name: person.name,
      description: body.description || person.position,
      style: body.style,
    });
    if (isFileBased) {
      await redis.hset(PEOPLE_AVATARS_KEY, id, result.avatar_url);
    } else {
      (person as PersonRecord).avatar_url = result.avatar_url;
      await redis.hset(PEOPLE_CUSTOM_KEY, id, JSON.stringify(person));
    }
    return c.json({ avatar_url: result.avatar_url });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// --- AI Chat helpers ---

/** Strip markdown code fences that LLMs sometimes wrap JSON in */
function stripMarkdownFences(raw: string): string {
  const m = raw.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/);
  return m ? m[1].trim() : raw;
}

// --- Tsunade Chat API ---

const TSUNADE_CHAT_PREFIX = "tsunade:chat:";
const CHAT_MAX_HISTORY = 20;

import Anthropic from "@anthropic-ai/sdk";
const _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TSUNADE_SYSTEM = `Ты — Цунаде, AI-ассистент редактора бизнес-процессов в нотации eEPC (Konoha Workflow Engine).
Ты помогаешь бизнес-архитектору работать со схемами процессов.

Типы элементов: event (начало/конец), function (задача/шаг), gateway (AND/OR/XOR развилка), role (исполнитель), document (документ), information_system (информационная система).
Связи flow: [[from_id, to_id], ...].
Позиции: {"element_id": {"x": N, "y": N}}.

Операции, которые ты можешь выполнять:
- Изменить названия элементов
- Выровнять расположение (вертикально сверху-вниз, горизонтально, по центру)
- Равномерно распределить элементы
- Добавить новый элемент (укажи тип, label, позицию)
- Удалить элемент

Когда нужно изменить схему, отвечай строго JSON:
{
  "reply": "Что ты сделал или ответ на вопрос",
  "schema_patch": {
    "update_elements": [{"id": "...", "label": "...", ...other fields}],
    "update_positions": {"id": {"x": N, "y": N}, ...},
    "add_elements": [{"type": "function", "label": "...", "x": N, "y": N}],
    "remove_elements": ["id1", "id2"]
  }
}

Если схему менять не нужно, отвечай JSON:
{"reply": "Твой ответ"}

ВАЖНО: отвечай ТОЛЬКО валидным JSON. Без markdown-оберток.`;

app.use("/tsunade/chat", requireAuth);
app.post("/tsunade/chat", async (c) => {
  const body = await c.req.json<{ message: string; schema?: unknown; chat_id?: string }>().catch(() => null);
  if (!body?.message?.trim()) return c.json({ error: "message required" }, 400);

  const chatId = body.chat_id || randomUUID();
  const histKey = TSUNADE_CHAT_PREFIX + chatId;

  // Load history
  const rawHistory = await redis.lrange(histKey, 0, -1).catch(() => [] as string[]);
  const history: { role: "user" | "assistant"; content: string }[] = rawHistory.map(r => {
    try { return JSON.parse(r); } catch { return null; }
  }).filter(Boolean);

  const schemaContext = body.schema
    ? `\nТекущая схема процесса:\n${JSON.stringify(body.schema, null, 2)}`
    : "";

  const userMsg = body.message + schemaContext;

  const messages: { role: "user" | "assistant"; content: string }[] = [
    ...history,
    { role: "user", content: userMsg },
  ];

  try {
    const response = await _anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      system: TSUNADE_SYSTEM,
      messages,
    });

    const rawReply = (response.content[0] as any).text.trim();

    // Parse JSON reply (strip markdown fences the model may have added)
    let reply = rawReply;
    let schema_patch: unknown = undefined;
    try {
      const parsed = JSON.parse(stripMarkdownFences(rawReply));
      reply = (typeof parsed.reply === "string" ? parsed.reply : null) || parsed.text || parsed.message || rawReply;
      if (parsed.schema_patch) schema_patch = parsed.schema_patch;
    } catch { /* not JSON, use raw text */ }

    // Save history (last N turns)
    await redis.rpush(histKey, JSON.stringify({ role: "user", content: body.message }));
    await redis.rpush(histKey, JSON.stringify({ role: "assistant", content: rawReply }));
    await redis.ltrim(histKey, -CHAT_MAX_HISTORY * 2, -1);
    await redis.expire(histKey, 7 * 24 * 3600); // 7 days TTL

    return c.json({ reply, chat_id: chatId, schema_patch: schema_patch ?? null });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

app.delete("/tsunade/chat/:chat_id", requireAuth, async (c) => {
  const chatId = c.req.param("chat_id");
  await redis.del(TSUNADE_CHAT_PREFIX + chatId).catch(() => {});
  return c.json({ ok: true });
});

// Alias: /ai/process-chat → same Tsunade logic (used by TsunadePanel component)
app.use("/ai/process-chat", requireAuth);
app.post("/ai/process-chat", async (c) => {
  // Delegate to the same handler as /tsunade/chat by re-using the same logic
  const body = await c.req.json<{ message: string; schema?: unknown; chat_id?: string }>().catch(() => null);
  if (!body?.message?.trim()) return c.json({ error: "message required" }, 400);

  const chatId = body.chat_id || randomUUID();
  const histKey = TSUNADE_CHAT_PREFIX + chatId;

  const rawHistory = await redis.lrange(histKey, 0, -1).catch(() => [] as string[]);
  const history: { role: "user" | "assistant"; content: string }[] = rawHistory.map(r => {
    try { return JSON.parse(r); } catch { return null; }
  }).filter(Boolean);

  const schemaContext = body.schema
    ? `\nТекущая схема процесса:\n${JSON.stringify(body.schema, null, 2)}`
    : "";

  const userMsg = body.message + schemaContext;
  const messages: { role: "user" | "assistant"; content: string }[] = [
    ...history,
    { role: "user", content: userMsg },
  ];

  try {
    const response = await _anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      system: TSUNADE_SYSTEM,
      messages,
    });

    const rawReply = (response.content[0] as any).text.trim();
    let reply = rawReply;
    let schema_patch: unknown = undefined;
    try {
      const parsed = JSON.parse(stripMarkdownFences(rawReply));
      reply = (typeof parsed.reply === "string" ? parsed.reply : null) || parsed.text || parsed.message || rawReply;
      if (parsed.schema_patch) schema_patch = parsed.schema_patch;
    } catch { /* not JSON, use raw text */ }

    await redis.rpush(histKey, JSON.stringify({ role: "user", content: body.message }));
    await redis.rpush(histKey, JSON.stringify({ role: "assistant", content: rawReply }));
    await redis.ltrim(histKey, -CHAT_MAX_HISTORY * 2, -1);
    await redis.expire(histKey, 7 * 24 * 3600);

    return c.json({ reply, chat_id: chatId, schema_patch: schema_patch ?? null });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

app.delete("/ai/process-chat/:chat_id", requireAuth, async (c) => {
  const chatId = c.req.param("chat_id");
  await redis.del(TSUNADE_CHAT_PREFIX + chatId).catch(() => {});
  return c.json({ ok: true });
});

// --- Kiba Admin Chat API ---

const KIBA_CHAT_PREFIX = "kiba:chat:";
const KIBA_CHAT_MAX_HISTORY = 16;

const KIBA_SYSTEM = `Ты — Киба, AI-ассистент администратора в системе Konoha.
Ты помогаешь управлять агентами, ролями и людьми через естественный язык.

Ты получаешь контекст текущей страницы (agents/roles/people) и список объектов.

Отвечай ТОЛЬКО валидным JSON (без markdown-оберток):
{
  "reply": "Текст ответа на русском",
  "actions": [
    { "label": "Текст кнопки", "type": "start_agent|stop_agent|restart_agent|delete_agent|create_role|delete_role", "args": {...} }
  ]
}

Если действий нет — массив actions пустой или отсутствует.

Поддерживаемые типы действий:
- start_agent: args: { id }
- stop_agent: args: { id }
- restart_agent: args: { id }
- delete_agent: args: { id } — только управляемые агенты
- create_role: args: { role_id, name, description?, strategy? }
- delete_role: args: { role_id }

Правила:
- Никогда не предлагай удалить системных агентов (naruto, sasuke)
- При запросе "остановить все" исключи naruto и sasuke
- Отвечай кратко и по делу
- Если не знаешь ID объекта — уточни у пользователя`;

app.use("/ai/admin-chat", requireAuth);
app.post("/ai/admin-chat", async (c) => {
  const body = await c.req.json<{ message: string; context?: { page: string; data: unknown[] }; chat_id?: string }>().catch(() => null);
  if (!body?.message?.trim()) return c.json({ error: "message required" }, 400);

  const chatId = body.chat_id || randomUUID();
  const histKey = KIBA_CHAT_PREFIX + chatId;

  // Load history
  const rawHistory = await redis.lrange(histKey, 0, -1).catch(() => [] as string[]);
  const history: { role: "user" | "assistant"; content: string }[] = rawHistory.map(r => {
    try { return JSON.parse(r); } catch { return null; }
  }).filter(Boolean);

  const contextBlock = body.context
    ? `\nКонтекст страницы "${body.context.page}":\n${JSON.stringify(body.context.data, null, 2)}`
    : "";

  const userMsg = body.message + contextBlock;
  const messages: { role: "user" | "assistant"; content: string }[] = [
    ...history,
    { role: "user", content: userMsg },
  ];

  try {
    const response = await _anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: KIBA_SYSTEM,
      messages,
    });

    const rawReply = (response.content[0] as any).text.trim();
    let reply = rawReply;
    let actions: unknown[] = [];
    try {
      const parsed = JSON.parse(stripMarkdownFences(rawReply));
      reply = (typeof parsed.reply === "string" ? parsed.reply : null) || parsed.text || parsed.message || rawReply;
      if (Array.isArray(parsed.actions)) actions = parsed.actions;
    } catch { /* not JSON, use raw text */ }

    // Save history
    await redis.rpush(histKey, JSON.stringify({ role: "user", content: body.message }));
    await redis.rpush(histKey, JSON.stringify({ role: "assistant", content: rawReply }));
    await redis.ltrim(histKey, -KIBA_CHAT_MAX_HISTORY * 2, -1);
    await redis.expire(histKey, 3 * 24 * 3600);

    return c.json({ reply, chat_id: chatId, actions });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

app.delete("/ai/admin-chat/:chat_id", requireAuth, async (c) => {
  const chatId = c.req.param("chat_id");
  await redis.del(KIBA_CHAT_PREFIX + chatId).catch(() => {});
  return c.json({ ok: true });
});

// --- Knowledge Base ---

const KB_DIR = "/opt/shared/wiki";
const KB_ALLOWED_EXT = new Set([".md", ".txt", ".json", ".yaml", ".yml"]);

function buildKbTree(dir: string, base: string): unknown[] {
  const entries = readdirSync(dir);
  const nodes: unknown[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const rel = join(base, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      nodes.push({ type: "dir", name: entry, path: rel, children: buildKbTree(full, rel) });
    } else {
      const ext = extname(entry);
      if (KB_ALLOWED_EXT.has(ext)) {
        nodes.push({ type: "file", name: entry, path: rel, size: st.size, ext });
      }
    }
  }
  return nodes;
}

app.use("/kb", requireAuth);
app.use("/kb/*", requireAuth);

app.get("/kb/tree", async (c) => {
  try {
    const tree = buildKbTree(KB_DIR, "");
    return c.json(tree);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

app.get("/kb/file", async (c) => {
  const path = c.req.query("path") || "";
  if (!path || path.includes("..")) return c.json({ error: "Invalid path" }, 400);
  const full = join(KB_DIR, path);
  if (!existsSync(full)) return c.json({ error: "Not found" }, 404);
  try {
    const content = readFileSync(full, "utf-8");
    return c.json({ content, path });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

app.get("/kb/search", async (c) => {
  const q = (c.req.query("q") || "").trim().toLowerCase();
  if (!q) return c.json([]);
  const results: { path: string }[] = [];
  function searchDir(dir: string, base: string) {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const full = join(dir, entry);
      const rel = join(base, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        searchDir(full, rel);
      } else if (KB_ALLOWED_EXT.has(extname(entry))) {
        try {
          const content = readFileSync(full, "utf-8").toLowerCase();
          if (content.includes(q)) results.push({ path: rel });
        } catch { /* skip unreadable */ }
      }
    }
  }
  try {
    searchDir(KB_DIR, "");
    return c.json(results.slice(0, 20));
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// --- Jiraiya KB Chat ---

const JIRAIYA_CHAT_PREFIX = "jiraiya:chat:";
const JIRAIYA_CHAT_MAX_HISTORY = 16;
const JIRAIYA_MAX_CONTEXT_CHARS = 12000;

const JIRAIYA_SYSTEM = `Ты — Дзирайя, AI-ассистент базы знаний в системе Konoha.
Ты помогаешь пользователям искать информацию, отвечать на вопросы и работать с корпусом документов.

Ты получаешь фрагменты документов из базы знаний (wiki) как контекст.
Отвечай строго на основе предоставленных документов. Если информации нет — скажи об этом честно.

Формат ответа — строго валидный JSON (без markdown-оберток):
{
  "reply": "Ответ на вопрос",
  "sources": ["путь/к/файлу1.md", "путь/к/файлу2.md"]
}

Правила:
- Цитируй только из предоставленного контекста
- Указывай источники (пути файлов), которые реально использовал в ответе
- Отвечай на том же языке, на котором задан вопрос
- Если вопрос о процессах — предложи открыть соответствующий процесс в редакторе
- Будь краток: 2–5 предложений если не нужно длиннее`;

function loadKbContext(query: string, filePath?: string): { text: string; sources: string[] } {
  const sources: string[] = [];
  const chunks: string[] = [];
  let remaining = JIRAIYA_MAX_CONTEXT_CHARS;

  // Always include the currently open file first
  if (filePath) {
    const full = join(KB_DIR, filePath);
    if (existsSync(full)) {
      try {
        const content = readFileSync(full, "utf-8");
        const chunk = content.slice(0, Math.min(4000, remaining));
        chunks.push(`## ${filePath}\n${chunk}`);
        sources.push(filePath);
        remaining -= chunk.length;
      } catch { /* skip */ }
    }
  }

  // Search and include relevant files
  const q = query.toLowerCase();
  function searchDir(dir: string, base: string) {
    if (remaining <= 0) return;
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (remaining <= 0) break;
      const full = join(dir, entry);
      const rel = join(base, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        searchDir(full, rel);
      } else if (KB_ALLOWED_EXT.has(extname(entry)) && rel !== filePath) {
        try {
          const content = readFileSync(full, "utf-8");
          if (content.toLowerCase().includes(q)) {
            const chunk = content.slice(0, Math.min(2000, remaining));
            chunks.push(`## ${rel}\n${chunk}`);
            sources.push(rel);
            remaining -= chunk.length;
          }
        } catch { /* skip */ }
      }
    }
  }
  try { searchDir(KB_DIR, ""); } catch { /* skip */ }

  return { text: chunks.join("\n\n---\n\n"), sources };
}

app.use("/ai/kb-chat", requireAuth);
app.post("/ai/kb-chat", async (c) => {
  const body = await c.req.json<{ message: string; file_path?: string; chat_id?: string }>().catch(() => null);
  if (!body?.message?.trim()) return c.json({ error: "message required" }, 400);

  const chatId = body.chat_id || randomUUID();
  const histKey = JIRAIYA_CHAT_PREFIX + chatId;

  const rawHistory = await redis.lrange(histKey, 0, -1).catch(() => [] as string[]);
  const history: { role: "user" | "assistant"; content: string }[] = rawHistory.map(r => {
    try { return JSON.parse(r); } catch { return null; }
  }).filter(Boolean);

  const { text: kbContext, sources } = loadKbContext(body.message, body.file_path);
  const contextBlock = kbContext
    ? `\n\nКонтекст из базы знаний:\n${kbContext}`
    : "\n\n(База знаний пуста или нет релевантных документов.)";

  const userMsg = body.message + contextBlock;
  const messages: { role: "user" | "assistant"; content: string }[] = [
    ...history,
    { role: "user", content: userMsg },
  ];

  try {
    const response = await _anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      system: JIRAIYA_SYSTEM,
      messages,
    });

    const rawReply = (response.content[0] as any).text.trim();
    let reply = rawReply;
    let replySources: string[] = sources.slice(0, 5);
    try {
      const parsed = JSON.parse(stripMarkdownFences(rawReply));
      reply = (typeof parsed.reply === "string" ? parsed.reply : null) || parsed.text || parsed.message || rawReply;
      if (Array.isArray(parsed.sources)) replySources = parsed.sources;
    } catch { /* use raw */ }

    await redis.rpush(histKey, JSON.stringify({ role: "user", content: body.message }));
    await redis.rpush(histKey, JSON.stringify({ role: "assistant", content: rawReply }));
    await redis.ltrim(histKey, -JIRAIYA_CHAT_MAX_HISTORY * 2, -1);
    await redis.expire(histKey, 3 * 24 * 3600);

    return c.json({ reply, chat_id: chatId, sources: replySources });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

app.delete("/ai/kb-chat/:chat_id", requireAuth, async (c) => {
  const chatId = c.req.param("chat_id");
  await redis.del(JIRAIYA_CHAT_PREFIX + chatId).catch(() => {});
  return c.json({ ok: true });
});

// --- Webhook Trigger ---
// Public endpoint — no auth (protected by unpredictable process_id)
// POST /trigger/:process_id?subject=...  → creates a case and returns case_id
app.post("/trigger/:process_id{.+}", async (c) => {
  const process_id = c.req.param("process_id");
  const body = await c.req.json().catch(() => ({}));
  const subject = (body.subject as string) || c.req.query("subject") || `webhook-${Date.now()}`;
  const payload = (body.payload && typeof body.payload === "object") ? body.payload : body;
  try {
    const kase = await createCase(process_id, subject, payload);
    return c.json({ case_id: kase.case_id, status: kase.status }, 201);
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

// --- Workspace ---

const WORKSPACE_DIR = "/opt/shared/workspace";
const WORKSPACE_ALLOWED_EXT = new Set([".docx", ".xlsx", ".pdf", ".png", ".jpg", ".jpeg", ".wav", ".mp3", ".m4a", ".ogg"]);
const AVATARS_DIR = "/opt/shared/avatars";

if (!existsSync(WORKSPACE_DIR)) {
  mkdirSync(WORKSPACE_DIR, { recursive: true });
}
if (!existsSync(AVATARS_DIR)) {
  mkdirSync(AVATARS_DIR, { recursive: true });
}

// Serve uploaded avatars
app.get("/avatars/:filename", (c) => {
  const filename = c.req.param("filename");
  if (filename.includes("..") || filename.includes("/")) return c.text("Forbidden", 403);
  const ext = extname(filename).toLowerCase();
  const mimeMap: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp" };
  const mime = mimeMap[ext] || "application/octet-stream";
  const filePath = join(AVATARS_DIR, filename);
  if (!existsSync(filePath)) return c.text("Not found", 404);
  return c.body(readFileSync(filePath), 200, { "content-type": mime, "cache-control": "public, max-age=86400" });
});

app.use("/workspace", requireAuth);
app.use("/workspace/*", requireAuth);

app.get("/workspace/files", async (c) => {
  const files = readdirSync(WORKSPACE_DIR).map(name => {
    const fullPath = join(WORKSPACE_DIR, name);
    const st = statSync(fullPath);
    return { name, size: st.size, modified_at: st.mtime.toISOString() };
  });
  return c.json(files);
});

app.post("/workspace/upload", async (c) => {
  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  if (!file) return c.json({ error: "file required" }, 400);
  const ext = extname(file.name).toLowerCase();
  if (!WORKSPACE_ALLOWED_EXT.has(ext)) {
    return c.json({ error: `File type not allowed: ${ext}` }, 415);
  }
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const destPath = join(WORKSPACE_DIR, safeName);
  const buf = Buffer.from(await file.arrayBuffer());
  writeFileSync(destPath, buf);
  return c.json({ name: safeName, size: buf.length }, 201);
});

app.delete("/workspace/files/:name", async (c) => {
  const name = c.req.param("name");
  if (name.includes("/") || name.includes("..")) return c.json({ error: "Invalid file name" }, 400);
  const filePath = join(WORKSPACE_DIR, name);
  if (!existsSync(filePath)) return c.json({ error: "Not found" }, 404);
  unlinkSync(filePath);
  return c.json({ ok: true });
});

// --- Channels ---

app.get("/channels", async (c) => {
  const channels = await listChannels();
  return c.json(channels);
});

app.get("/channels/:name/history", async (c) => {
  const name = c.req.param("name");
  const count = parseInt(c.req.query("count") || "20");
  const messages = await readHistory(name, count);
  return c.json(messages);
});

// --- Workflows ---

app.get("/workflows", requireAuth, async (c) => {
  const workflows = await listWorkflows();
  return c.json(workflows);
});

// NOTE: /versions sub-route must be declared BEFORE the wildcard get below
app.get("/workflows/:id{.+}/versions", requireAuth, async (c) => {
  const id = c.req.param("id");
  const versions = await listWorkflowVersions(id);
  return c.json(versions);
});

// :id{.+} captures slashes so IDs like "general/reflection" work correctly
app.get("/workflows/:id{.+}", requireAuth, async (c) => {
  const id = c.req.param("id");
  const wf = await getWorkflow(id);
  if (!wf) return c.json({ error: "Workflow not found" }, 404);
  return c.json(wf);
});

app.post("/workflows", requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  if (!body.id || !body.name) return c.json({ error: "id and name required" }, 400);
  const draft = c.req.query("draft") === "true";
  let normalized = false;
  if (body.elements?.length) {
    const nameMap = await normalizeElementNames(body.elements).catch(() => ({}));
    if (Object.keys(nameMap).length) {
      body.elements = body.elements.map((el: any) => nameMap[el.id] ? { ...el, label: nameMap[el.id] } : el);
      normalized = true;
    }
  }
  const result = await createWorkflow(body, { draft });
  if (result.errors.length > 0) return c.json({ error: "Validation failed", details: result.errors }, 422);
  return c.json({ ...result.workflow, normalized }, 201);
});

app.put("/workflows/:id{.+}", requireAuth, async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const draft = c.req.query("draft") === "true";
  let normalized = false;
  if (body.elements?.length) {
    const nameMap = await normalizeElementNames(body.elements).catch(() => ({}));
    if (Object.keys(nameMap).length) {
      body.elements = body.elements.map((el: any) => nameMap[el.id] ? { ...el, label: nameMap[el.id] } : el);
      normalized = true;
    }
  }
  const result = await updateWorkflow(id, body, { draft });
  if (result === null) return c.json({ error: "Workflow not found" }, 404);
  if (result.errors.length > 0) return c.json({ error: "Validation failed", details: result.errors }, 422);
  return c.json({ ...result.workflow, normalized });
});

app.delete("/workflows/:id{.+}", requireAuth, async (c) => {
  const id = c.req.param("id");
  const ok = await archiveWorkflow(id);
  if (!ok) return c.json({ error: "Workflow not found" }, 404);
  return c.json({ ok: true, archived: id });
});

// Load workflow definitions from disk into Redis on startup
const WORKFLOWS_DIR = process.env.KONOHA_WORKFLOWS_DIR || join(import.meta.dir, "..", "workflows");
loadWorkflows(WORKFLOWS_DIR).then(({ loaded, errors }) => {
  console.log(`[workflow-loader] startup: ${loaded} loaded, ${errors} failed validation`);
}).catch((e) => {
  console.error("[workflow-loader] startup error:", e.message);
});

// Initialize Tsunade event handler (KWE-006)
import { initTsunade } from "./tsunade";
initTsunade().catch((e) => {
  console.error("[tsunade] init error:", e.message);
});

startReminderScheduler();

// ── Seed system agents ──────────────────────────────────────────────────────

const SYSTEM_AGENTS = [
  { id: "naruto", name: "Наруто (Оркестратор)", model: "claude-sonnet-4-6", tags: ["system"], tmux_session_override: "naruto", gender: "male" as const },
  { id: "sasuke", name: "Саске", model: "claude-sonnet-4-6", tags: ["system"], tmux_session_override: "sasuke", gender: "male" as const },
  { id: "kakashi", name: "Какаши (Мастер багфиксинга)", model: "claude-sonnet-4-6", tags: ["system"], tmux_session_override: "kakashi", gender: "male" as const },
  { id: "mirai", name: "Мирай", model: "claude-haiku-4-5-20251001", tags: ["system"], tmux_session_override: "mirai", gender: "female" as const },
];

async function seedSystemAgents() {
  for (const ag of SYSTEM_AGENTS) {
    const existing = await getAgentDef(ag.id).catch(() => null);
    if (!existing) {
      await createAgentDef({ ...ag, protected: true }).catch((e: any) => {
        console.error(`[seed] failed to create agent def for ${ag.id}:`, e.message);
      });
      console.log(`[seed] created system AgentDef: ${ag.id}`);
    }
  }
}
seedSystemAgents().catch(e => console.error("[seed] system agents error:", e.message));

// POST /admin/seed-system-agents — re-run seed (idempotent)
app.post("/admin/seed-system-agents", requireAuth, async (c) => {
  const results: string[] = [];
  for (const ag of SYSTEM_AGENTS) {
    const existing = await getAgentDef(ag.id).catch(() => null);
    if (!existing) {
      await createAgentDef({ ...ag, protected: true });
      results.push(`created: ${ag.id}`);
    } else {
      results.push(`exists: ${ag.id}`);
    }
  }
  return c.json({ ok: true, results });
});

console.log(`Konoha bus listening on port ${PORT}`);
export { app };
export default {
  port: PORT,
  fetch: app.fetch,
  idleTimeout: 0, // disable Bun's 10s idle timeout — SSE streams stay open indefinitely
};
