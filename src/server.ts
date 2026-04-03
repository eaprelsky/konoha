import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { streamSSE } from "hono/streaming";
import { mkdirSync, writeFileSync, existsSync, statSync, readFileSync, readdirSync, unlinkSync } from "fs";
import { join, extname, basename } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
const execFileAsync = promisify(execFile);
import { loadWorkflows, getWorkflow, listWorkflows, createWorkflow, updateWorkflow, archiveWorkflow, listWorkflowVersions } from "./workflow-loader";
import { createCase, getCase, completeWorkItem, listWorkItems, listCases, listEvents, createStandaloneWorkItem, updateWorkItem, processEvent, createReminder, listReminders, updateReminderStatus, deleteReminder, startReminderScheduler, createRole, listRoles, updateRole, deleteRole, createDoc, listDocs, updateDoc, deleteDoc, type WorkItemStatus, type CaseStatus, type ReminderStatus, type ReminderChannel, type ReminderType, type AssignmentStrategy, type DocType } from "./runtime";
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
  // Merge lifecycle state into bus agents
  const agentsWithState = await Promise.all(
    busAgents.map(async (a) => {
      const def = defMap.get(a.id);
      if (!def) return a;
      const state = await getAgentState(a.id);
      return { ...a, lifecycle: { status: state.status, pid: state.pid, uptime_seconds: state.uptime_seconds } };
    })
  );
  // Also include managed agents not yet on the bus
  const busIds = new Set(busAgents.map(a => a.id));
  const unmatchedDefs = defs.filter(d => !busIds.has(d.id));
  const unmatchedWithState = await Promise.all(
    unmatchedDefs.map(async (d) => {
      const state = await getAgentState(d.id);
      return { ...d, status: "offline", lifecycle: { status: state.status, pid: state.pid, uptime_seconds: state.uptime_seconds } };
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

type PersonRecord = { id: string; name: string; tg_id: number; position: string; tg_username?: string; email?: string };

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
      people.push({ id: toId(data.owner.name, data.owner.username), name: data.owner.name, tg_id: data.owner.telegram_id, position: "Owner", tg_username: data.owner.username || undefined });
    }
    for (const u of data.trusted || []) {
      people.push({ id: toId(u.name, u.username), name: u.name, tg_id: u.telegram_id, position: u.position || "", tg_username: u.username || undefined });
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
      map.set(p.id, p);
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
  };
  await redis.hset(PEOPLE_CUSTOM_KEY, id, JSON.stringify(record));
  return c.json(record, 201);
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
  const result = await createWorkflow(body);
  if (result.errors.length > 0) return c.json({ error: "Validation failed", details: result.errors }, 422);
  return c.json(result.workflow, 201);
});

app.put("/workflows/:id{.+}", requireAuth, async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const result = await updateWorkflow(id, body);
  if (result === null) return c.json({ error: "Workflow not found" }, 404);
  if (result.errors.length > 0) return c.json({ error: "Validation failed", details: result.errors }, 422);
  return c.json(result.workflow);
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

console.log(`Konoha bus listening on port ${PORT}`);
export { app };
export default {
  port: PORT,
  fetch: app.fetch,
  idleTimeout: 0, // disable Bun's 10s idle timeout — SSE streams stay open indefinitely
};
