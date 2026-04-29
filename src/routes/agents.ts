import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { mkdirSync, existsSync, statSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from "fs";
import { join, basename } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
const execFileAsync = promisify(execFile);

import { requireAuth, requireAdmin, requireAgentSelfOrAdmin, ADMIN_TOKEN } from "../middleware/auth";
import {
  registerAgent,
  unregisterAgent,
  heartbeat,
  listAgents,
} from "../redis";
import { consumeInvite, createInvite } from "../redis";
import {
  createAgentDef,
  getAgentDef,
  deleteAgentDef,
  listAgentDefs,
  updateAgentDef,
  getAgentState,
  startAgent,
  stopAgent,
  restartAgent,
  buildSystemPrompt,
  isTmuxRunning,
  listLLMClientProfiles,
  getLLMClientProfile,
  resolveLLMClientProfile,
  listToolProfiles,
  getToolProfile,
  listSandboxProfiles,
  getSandboxProfile,
  composeAgentView,
} from "../agent-lifecycle";
import type { AgentRuntimeState, LifecycleStatus, AgentProvider, AgentView } from "../agent-lifecycle";
import { silentCatch } from "../logger";

const router = new Hono<HonoEnv>();

type LifecycleProjection = Pick<AgentRuntimeState, "pid" | "uptime_seconds"> & { status: LifecycleStatus };

function routeRuntimeState(agentId: string, lifecycle: LifecycleProjection): AgentRuntimeState {
  return {
    agent_id: agentId,
    status: lifecycle.status,
    pid: lifecycle.pid,
    uptime_seconds: lifecycle.uptime_seconds,
  };
}

function validateLLMClientProfile(id: unknown, field: string): { error: string } | null {
  if (id === undefined || id === null || id === "") return null;
  if (typeof id !== "string") return { error: `${field} must be a string` };
  if (!getLLMClientProfile(id)) return { error: `Unknown ${field}: ${id}` };
  return null;
}

function validateToolProfile(id: unknown): { error: string } | null {
  if (id === undefined || id === null || id === "") return null;
  if (typeof id !== "string") return { error: "tool_profile must be a string" };
  if (!getToolProfile(id)) return { error: `Unknown tool_profile: ${id}` };
  return null;
}

function validateSandboxProfile(id: unknown): { error: string } | null {
  if (id === undefined || id === null || id === "") return null;
  if (typeof id !== "string") return { error: "sandbox_profile must be a string" };
  if (!getSandboxProfile(id)) return { error: `Unknown sandbox_profile: ${id}` };
  return null;
}

// Apply auth to all protected routes
// /agents/register is handled inline (invite token logic, no middleware)
router.use("/invite", requireAdmin);
router.use("/:id/heartbeat", requireAuth);
router.use("/:id/start", requireAuth);
router.use("/:id/stop", requireAuth);
router.use("/:id/restart", requireAuth);
router.use("/:id/status", requireAuth);
router.use("/:id", (c, next) => {
  // /agents/register has its own auth — skip middleware for it
  if (c.req.path === "/agents/register") return next();
  return requireAuth(c, next);
});
router.use("/", requireAuth);

// Issue a one-time invite token (admin only)
router.post("/invite", async (c) => {
  const invite = await createInvite();
  return c.json(invite, 201);
});

// Register: requires admin token OR a valid (one-time) invite token
router.post("/register", async (c) => {
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

// POST /agents — create a managed agent definition
router.post("/", requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const {
    id,
    name,
    system_prompt,
    startup_sequence,
    runtime,
    fallback_runtime,
    llm_client_profile = (!runtime ? "claude-deepseek-sonnet" : undefined),
    fallback_llm_client_profile,
    runtime_profiles,
    active_runtime_profile,
    fallback_runtime_profile,
    auto_runtime_fallback,
    launch_strategy,
    startup_timeout_sec,
    model = "claude:sonnet",
    reasoning_effort,
    env,
    tags,
    capabilities,
    tool_profile,
    sandbox_profile = "tmux",
    memory,
  } = body;
  if (!id || !name) return c.json({ error: "id and name required" }, 400);
  const profileError = validateLLMClientProfile(llm_client_profile, "llm_client_profile")
    ?? validateLLMClientProfile(fallback_llm_client_profile, "fallback_llm_client_profile")
    ?? validateToolProfile(tool_profile)
    ?? validateSandboxProfile(sandbox_profile);
  if (profileError) return c.json(profileError, 400);
  const def = await createAgentDef({
    id,
    name,
    system_prompt,
    startup_sequence,
    runtime,
    fallback_runtime,
    llm_client_profile,
    fallback_llm_client_profile,
    runtime_profiles,
    active_runtime_profile,
    fallback_runtime_profile,
    auto_runtime_fallback,
    launch_strategy,
    startup_timeout_sec,
    model,
    reasoning_effort,
    env,
    tags,
    capabilities,
    tool_profile,
    sandbox_profile,
    memory,
  });
  // Prepare personal memory directory
  mkdirSync(`/opt/shared/agent-memory/${id}`, { recursive: true });
  return c.json(def, 201);
});

// GET /agents/llm-client-profiles — available runtime adapter/provider/model profiles
router.get("/llm-client-profiles", async (c) => {
  return c.json(listLLMClientProfiles());
});

// GET /agents/tool-profiles — available tool/plugin profiles (#571)
router.get("/tool-profiles", async (c) => {
  return c.json(listToolProfiles());
});

router.get("/sandbox-profiles", async (c) => {
  return c.json(listSandboxProfiles());
});

// GET /agents/:id/status — lifecycle status (tmux state, pid, uptime)
router.get("/:id/status", requireAgentSelfOrAdmin(), async (c) => {
  const id = c.req.param("id")!;
  const def = await getAgentDef(id);
  if (!def) return c.json({ error: "Agent not found" }, 404);
  const state = await getAgentState(id);
  return c.json(state);
});

// POST /agents/:id/start
router.post("/:id/start", requireAdmin, async (c) => {
  const id = c.req.param("id")!;
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
router.post("/:id/stop", requireAdmin, async (c) => {
  const id = c.req.param("id")!;
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
router.post("/:id/restart", requireAdmin, async (c) => {
  const id = c.req.param("id")!;
  const def = await getAgentDef(id);
  if (!def) return c.json({ error: "Agent not found" }, 404);
  try {
    const state = await restartAgent(id, def);
    return c.json(state);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// POST /agents/:id/switch-runtime — change runtime/profile and optionally restart
router.post("/:id/switch-runtime", requireAdmin, async (c) => {
  const id = c.req.param("id")!;
  const def = await getAgentDef(id);
  if (!def) return c.json({ error: "Agent not found or not managed" }, 404);
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON" }, 400);
  const { profile, llm_client_profile, runtime, model, reasoning_effort, fallback_runtime, fallback_llm_client_profile, tool_profile, sandbox_profile, restart } = body;
  const profileError = validateLLMClientProfile(llm_client_profile, "llm_client_profile")
    ?? validateLLMClientProfile(fallback_llm_client_profile, "fallback_llm_client_profile")
    ?? validateToolProfile(tool_profile)
    ?? validateSandboxProfile(sandbox_profile);
  if (profileError) return c.json(profileError, 400);
  const updates: Record<string, unknown> = {};
  const legacyProfile = typeof profile === "string" ? def.runtime_profiles?.[profile] : undefined;
  if (profile && def.runtime_profiles && !legacyProfile && runtime === undefined && llm_client_profile === undefined) {
    return c.json({ error: `Runtime profile not found: ${profile}` }, 404);
  }
  if (legacyProfile) {
    updates.runtime = legacyProfile.runtime;
    updates.model = legacyProfile.model;
    updates.active_runtime_profile = profile;
    if (legacyProfile.codex_disable_features !== undefined) {
      updates.codex_disable_features = legacyProfile.codex_disable_features;
    }
  }

  const nextRuntime = runtime ?? (legacyProfile ? undefined : profile);
  if (llm_client_profile !== undefined) {
    updates.llm_client_profile = llm_client_profile;
  } else if (profile && !legacyProfile) {
    const resolved = resolveLLMClientProfile({ runtime: profile as AgentProvider, model: profile });
    if (resolved) updates.llm_client_profile = resolved.id;
  }
  if (nextRuntime !== undefined) updates.runtime = nextRuntime;
  if (model !== undefined) {
    updates.model = model;
  } else if (typeof updates.llm_client_profile === "string") {
    const prof = getLLMClientProfile(updates.llm_client_profile);
    if (prof) updates.model = prof.runtime_adapter === "codex" ? prof.model : `${prof.runtime_adapter}:${prof.runtime_model || prof.model}`;
  }
  if (reasoning_effort !== undefined) updates.reasoning_effort = reasoning_effort;
  if (fallback_runtime !== undefined) updates.fallback_runtime = fallback_runtime;
  if (fallback_llm_client_profile !== undefined) updates.fallback_llm_client_profile = fallback_llm_client_profile;
  if (tool_profile !== undefined) updates.tool_profile = tool_profile;
  if (sandbox_profile !== undefined) updates.sandbox_profile = sandbox_profile;
  if (Object.keys(updates).length === 0) return c.json({ error: "No fields to update" }, 400);
  const updated = await updateAgentDef(id, updates);
  if (!updated) return c.json({ error: "Agent not found or not managed" }, 404);
  let state = null;
  if (restart) {
    try {
      state = await restartAgent(id, updated);
    } catch (e: any) {
      return c.json({ def: updated, error: `Profile updated but restart failed: ${e.message}` }, 500);
    }
  }
  return c.json({
    ok: true,
    agent_id: id,
    active_runtime_profile: updated.active_runtime_profile,
    runtime: updated.runtime,
    model: updated.model,
    def: updated,
    state,
  });
});

// GET /agents/tmux/:id — capture tmux pane output (last 200 lines)
router.use("/tmux/:id", requireAdmin);
router.get("/tmux/:id", async (c) => {
  const id = c.req.param("id")!;
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

// GET /agents/:id/system-template — rendered system template (includes role blocks + skills)
router.get("/:id/system-template", requireAgentSelfOrAdmin(), async (c) => {
  const id = c.req.param("id")!;
  const def = await getAgentDef(id);
  const base = def ?? { id, name: id, runtime: "claude" as const, model: "claude:sonnet", system_prompt: undefined, capabilities: [] };
  const template = await buildSystemPrompt(id, base);
  return c.json({ template });
});

// GET /agents/:id/memory — list memory files for agent
router.get("/:id/memory", requireAgentSelfOrAdmin(), async (c) => {
  const id = c.req.param("id")!;
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
router.get("/:id/memory/:filename", requireAgentSelfOrAdmin(), async (c) => {
  const id = c.req.param("id")!;
  const filename = basename(c.req.param("filename")!); // prevent path traversal
  const dir = `/opt/shared/agent-memory/${basename(id)}`;
  const filepath = join(dir, filename);
  if (!existsSync(filepath)) return c.json({ error: "Not found" }, 404);
  const content = readFileSync(filepath, "utf-8");
  return c.text(content);
});

// DELETE /agents/:id/memory/:filename — delete one memory file
router.delete("/:id/memory/:filename", requireAgentSelfOrAdmin(), async (c) => {
  const id = c.req.param("id")!;
  const filename = basename(c.req.param("filename")!); // prevent path traversal
  const dir = `/opt/shared/agent-memory/${basename(id)}`;
  const filepath = join(dir, filename);
  if (!existsSync(filepath)) return c.json({ error: "Not found" }, 404);
  unlinkSync(filepath);
  return c.json({ ok: true });
});

// PUT /agents/:id/memory/:filename — overwrite memory file content
router.put("/:id/memory/:filename", requireAgentSelfOrAdmin(), async (c) => {
  const id = c.req.param("id")!;
  const filename = basename(c.req.param("filename")!);
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
router.post("/:id/memory/:filename", requireAgentSelfOrAdmin(), async (c) => {
  const id = c.req.param("id")!;
  const filename = basename(c.req.param("filename")!);
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
router.get("/:id", requireAgentSelfOrAdmin(), async (c) => {
  const id = c.req.param("id")!;
  const [busAgents, def] = await Promise.all([
    listAgents(false),
    getAgentDef(id),
  ]);
  const busAgent = busAgents.find(a => a.id === id);
  if (!busAgent && !def) return c.json({ error: "Agent not found" }, 404);
  const base = busAgent ?? { id, status: "offline" };
  if (!def) return c.json(base);

  let lifecycle: LifecycleProjection;
  if (def.tmux_session_override) {
    const sess = def.tmux_session_override;
    const runningNamedSocket = await execFileAsync("tmux", ["-L", sess, "has-session", "-t", sess]).then(() => true).catch(() => false);
    const running = runningNamedSocket || await isTmuxRunning(sess);
    lifecycle = { status: running ? "running" : "stopped" };
  } else {
    const state = await getAgentState(id);
    lifecycle = { status: state.status, pid: state.pid, uptime_seconds: state.uptime_seconds };
  }

  return c.json(composeAgentView({
    id,
    def,
    busAgent: base,
    runtimeState: routeRuntimeState(id, lifecycle),
  }));
});

// PUT /agents/:id — update agent definition fields (name, system_prompt, model)
router.put("/:id", requireAdmin, async (c) => {
  const id = c.req.param("id")!;
  const def = await getAgentDef(id);
  if (!def) return c.json({ error: "Agent not found or not managed" }, 404);
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON" }, 400);
  const updated = await updateAgentDef(id, body);
  if (!updated) return c.json({ error: "Agent not found or not managed" }, 404);
  return c.json(updated);
});

// DELETE /agents/:id — stop agent, delete definition, and unregister from bus
router.delete("/:id", requireAdmin, async (c) => {
  const id = c.req.param("id")!;
  const def = await getAgentDef(id);
  if (def?.protected) return c.json({ error: "Cannot delete a protected system agent" }, 403);
  if (def) {
    // Stop if running
    const state = await getAgentState(id);
    if (state.status === "running" || state.status === "starting") {
      await stopAgent(id).catch(silentCatch("stop agent on cleanup"));
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
// In-memory cache for tmux lifecycle status — avoids spawning N processes per request
const _lifecycleCache = new Map<string, { data: LifecycleProjection; ts: number }>();
const LIFECYCLE_CACHE_TTL_MS = 5_000;

router.get("/", requireAdmin, async (c) => {
  const onlineOnly = c.req.query("online") === "true";
  const [busAgents, defs] = await Promise.all([
    listAgents(onlineOnly),
    listAgentDefs(),
  ]);
  // Build a map from managed defs for quick lookup
  const defMap = new Map(defs.map(d => [d.id, d]));
  async function lifecycleForDef(id: string, def: { protected?: boolean; tmux_session_override?: string }): Promise<LifecycleProjection> {
    const cacheKey = def.tmux_session_override ? `tmux:${def.tmux_session_override}` : `agent:${id}`;
    const cached = _lifecycleCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < LIFECYCLE_CACHE_TTL_MS) {
      return cached.data;
    }
    let result: LifecycleProjection;
    if (def.tmux_session_override) {
      const sess = def.tmux_session_override;
      // System agents (naruto/sasuke/mirai) use named tmux sockets (-L <session>)
      const runningNamedSocket = await execFileAsync("tmux", ["-L", sess, "has-session", "-t", sess]).then(() => true).catch(() => false);
      const running = runningNamedSocket || await isTmuxRunning(sess);
      result = { status: running ? "running" : "stopped" };
    } else {
      const state = await getAgentState(id);
      result = { status: state.status, pid: state.pid, uptime_seconds: state.uptime_seconds };
    }
    _lifecycleCache.set(cacheKey, { data: result, ts: Date.now() });
    return result;
  }

  // Merge lifecycle state into bus agents
  const agentsWithState = await Promise.all(
    busAgents.map(async (a) => {
      const def = defMap.get(a.id);
      if (!def) return a;
      const lifecycle = await lifecycleForDef(a.id, def);
      return composeAgentView({
        id: a.id,
        def,
        busAgent: a,
        runtimeState: routeRuntimeState(a.id, lifecycle),
      });
    })
  );
  // Also include managed agents not yet on the bus
  const busIds = new Set(busAgents.map(a => a.id));
  const unmatchedDefs = defs.filter(d => !busIds.has(d.id));
  const unmatchedWithState = await Promise.all(
    unmatchedDefs.map(async (d) => {
      const lifecycle = await lifecycleForDef(d.id, d);
      return composeAgentView({
        id: d.id,
        def: d,
        busAgent: { id: d.id, status: "offline" },
        runtimeState: routeRuntimeState(d.id, lifecycle),
      });
    })
  );
  const allViews = [...agentsWithState, ...unmatchedWithState];

  // ?format=v2 — return split boundaries: templates, presences, runtime_states
  if (c.req.query("format") === "v2") {
    return c.json({
      templates: allViews.map(v => "template" in v ? (v as AgentView).template : null).filter(Boolean),
      presences: allViews.map(v => "presence" in v ? (v as AgentView).presence : null).filter(Boolean),
      runtime_states: allViews.map(v => "runtime_state" in v ? (v as AgentView).runtime_state : null).filter(Boolean),
    });
  }

  return c.json(allViews);
});

router.post("/:id/heartbeat", async (c) => {
  const id = c.req.param("id")!;
  const caller: { isAdmin: boolean; agentId: string | null } = c.get("caller");
  if (!caller.isAdmin && caller.agentId !== id) {
    return c.json({ error: "Forbidden: can only send heartbeat for yourself" }, 403);
  }
  await heartbeat(id);
  return c.json({ ok: true });
});

export default router;
