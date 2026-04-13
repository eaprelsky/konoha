/**
 * agent-lifecycle.ts — Agent definition store + process lifecycle management.
 * Separate from the bus registry (redis.ts) which tracks message-routing status.
 *
 * Stores persistent agent definitions and manages OS-level start/stop via tmux.
 */

import { redis } from "./redis";
import { getBranding } from "./routes/audit";
import { getWorkflow } from "./workflow-loader";
import { execFile } from "child_process";
import { promisify } from "util";
import { randomUUID } from "crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";

const AGENT_WORKDIR_ROOT = "/opt/shared/agent-workdirs";
const DEFAULT_AGENT_MODEL = "claude-sonnet-4-6";
const CODEX_CONFIG_PATH = "/home/ubuntu/.codex/config.toml";

type AgentProvider = "claude" | "codex" | "cursor";

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\''`)}'`;
}

function tomlEscape(value: string): string {
  return JSON.stringify(value);
}

function toToml(value: string | string[] | Record<string, string>): string {
  if (typeof value === "string") return tomlEscape(value);
  if (Array.isArray(value)) return `[${value.map(tomlEscape).join(", ")}]`;
  return `{ ${Object.entries(value).map(([k, v]) => `${k} = ${tomlEscape(v)}`).join(", ")} }`;
}

function configPathSegment(value: string): string {
  return /^[A-Za-z0-9_]+$/.test(value) ? value : JSON.stringify(value);
}

function ensureCodexProjectTrusted(workdir: string): void {
  const section = `[projects.${JSON.stringify(workdir)}]`;
  const block = `${section}
trust_level = "trusted"
`;
  const current = existsSync(CODEX_CONFIG_PATH) ? readFileSync(CODEX_CONFIG_PATH, "utf-8") : "";
  if (current.includes(section)) return;
  const next = current.trimEnd() ? `${current.trimEnd()}

${block}` : block;
  mkdirSync(join(CODEX_CONFIG_PATH, ".."), { recursive: true });
  writeFileSync(CODEX_CONFIG_PATH, next, "utf-8");
}

function resolveAgentRuntime(model?: string): { provider: AgentProvider; runtimeModel: string } {
  const raw = (model || DEFAULT_AGENT_MODEL).trim();
  const namespaced = raw.match(/^(claude|codex|cursor):(.*)$/);
  if (namespaced) {
    return {
      provider: namespaced[1] as AgentProvider,
      runtimeModel: (namespaced[2] || DEFAULT_AGENT_MODEL).trim(),
    };
  }
  if (raw.startsWith("claude-")) return { provider: "claude", runtimeModel: raw };
  if (raw.startsWith("cursor-")) return { provider: "cursor", runtimeModel: raw.slice("cursor-".length) || "sonnet-4" };
  if (raw.startsWith("codex-") && raw !== "codex") return { provider: "codex", runtimeModel: raw.slice("codex-".length) || "gpt-5" };
  if (raw.startsWith("gpt-") || raw.startsWith("o1") || raw.startsWith("o3") || raw.startsWith("o4")) {
    return { provider: "codex", runtimeModel: raw };
  }
  if (raw.startsWith("sonnet-") || raw === "gpt-5") {
    return { provider: "cursor", runtimeModel: raw };
  }
  return { provider: "claude", runtimeModel: raw };
}

// ── System template ──────────────────────────────────────────────────────────

const SYSTEM_TEMPLATE = `\
# System Instructions (managed by Konoha — do not edit)

## Identity
- Agent ID: {{id}}
- Agent Name: {{name}}
- Model: {{model}}
- Language: Russian (communicate in Russian unless overridden in user instructions)

## Startup sequence
1. source /home/ubuntu/.agent-env
2. Read /opt/shared/agent-memory/MEMORY.md and all referenced files
3. Register on Konoha bus: konoha_register(id={{id}}, name={{name}}, model={{model}})
4. Read your personal memory if it exists: /opt/shared/agent-memory/{{id}}/MEMORY.md
5. Wait for tasks — watchdog delivers them via Konoha bus

## Konoha Bus
- HTTP API: http://127.0.0.1:3200
- Token: stored in KONOHA_TOKEN env var
- Use MCP tools: konoha_send, konoha_read, konoha_register, konoha_heartbeat
- Messages arrive via watchdog — do NOT poll manually

## Watchdog behavior
When you receive a task via watchdog injection, process it and respond via konoha_send.
Session cleanup fires every 2h — save work-state and do /new when requested.

---
# User Instructions`;

export function renderSystemTemplate(def: Pick<AgentDef, "id" | "name" | "model">): string {
  return SYSTEM_TEMPLATE
    .replace(/{{id}}/g, def.id)
    .replace(/{{name}}/g, def.name)
    .replace(/{{model}}/g, def.model || DEFAULT_AGENT_MODEL);
}

/**
 * Build Layer 3 (role blocks) for this agent's composite system prompt.
 * For each role where this agent is an assignee, extracts assigned functions
 * from associated workflows and formats them as readable instructions.
 */
export async function buildRoleBlocks(agentId: string): Promise<string> {
  const roleIds = await redis.zrange("konoha:roles:all", 0, -1).catch(() => [] as string[]);
  if (roleIds.length === 0) return "";

  const blocks: string[] = [];

  for (const roleId of roleIds) {
    const raw = await redis.get(`role:${roleId}`).catch(() => null);
    if (!raw) continue;
    const role = JSON.parse(raw) as { role_id: string; name: string; assignees: string[]; description?: string };
    if (!role.assignees.includes(agentId)) continue;

    const workflowIds = await redis.smembers(`konoha:role:${roleId}:workflows`).catch(() => [] as string[]);
    if (workflowIds.length === 0) continue;

    const roleLines: string[] = [`## Role: ${role.name}`];
    if (role.description) roleLines.push(role.description);
    roleLines.push("\nYou perform the following functions in business processes:\n");

    for (const wfId of workflowIds) {
      const wf = await getWorkflow(wfId).catch(() => null);
      if (!wf) continue;

      const functions = wf.elements.filter(el => el.type === "function" && el.role === roleId);
      if (functions.length === 0) continue;

      roleLines.push(`### Process: ${wf.name}`);

      const outEdges = new Map<string, string[]>();
      const inEdges = new Map<string, string[]>();
      for (const el of wf.elements) { outEdges.set(el.id, []); inEdges.set(el.id, []); }
      for (const [from, to] of wf.flow) {
        outEdges.get(from)?.push(to as string);
        inEdges.get(to as string)?.push(from);
      }
      const byId = new Map(wf.elements.map(e => [e.id, e]));

      for (const fn of functions) {
        roleLines.push(`\n#### ${fn.label}`);

        const inputEvents = (inEdges.get(fn.id) ?? [])
          .map(id => byId.get(id))
          .filter(el => el?.type === "event");
        if (inputEvents.length > 0) {
          roleLines.push(`- Triggered by: ${inputEvents.map(e => e!.label).join(", ")}`);
        }

        const outputEvents = (outEdges.get(fn.id) ?? [])
          .map(id => byId.get(id))
          .filter(el => el?.type === "event");
        if (outputEvents.length > 0) {
          roleLines.push(`- Produces: ${outputEvents.map(e => e!.label).join(", ")}`);
        }

        if (fn.documents?.length) roleLines.push(`- Documents: ${fn.documents.join(", ")}`);
        if (fn.systems?.length) roleLines.push(`- Systems: ${fn.systems.map(s => s.connector).join(", ")}`);
        if (fn.intent) roleLines.push(`- Goal: ${fn.intent}`);
      }
    }

    blocks.push(roleLines.join("\n"));
  }

  if (blocks.length === 0) return "";
  return "\n\n---\n# Role Assignments\n\n" + blocks.join("\n\n");
}

/**
 * Builds the complete agent system prompt: system template + user instructions + role blocks + skill snippets.
 * Used by startAgent() and GET /agents/:id/system-template.
 */
export async function buildSystemPrompt(agentId: string, def: Pick<AgentDef, "id" | "name" | "model" | "system_prompt" | "capabilities">): Promise<string> {
  // Substitute {display_name} from branding config (closes #298)
  const branding = await getBranding().catch(() => null);
  const displayName = branding?.agent_display_names?.[agentId] ?? def.name;

  const base = renderSystemTemplate({ ...def, name: displayName });
  const userInstructions = (def.system_prompt?.trim() ?? "")
    .replace(/\{display_name\}/g, displayName);
  const roleBlocks = await buildRoleBlocks(agentId);

  let skillSnippets = "";
  if (def.capabilities && def.capabilities.length > 0) {
    const snippets: string[] = [];
    for (const skillId of def.capabilities) {
      const raw = await redis.get(`konoha:skill:${skillId}`).catch(() => null);
      if (raw) {
        const skill = JSON.parse(raw) as { prompt_snippet?: string; name?: string };
        if (skill.prompt_snippet?.trim()) {
          snippets.push(`## Skill: ${skill.name || skillId}\n${skill.prompt_snippet.trim()}`);
        }
      }
    }
    if (snippets.length > 0) skillSnippets = "\n\n" + snippets.join("\n\n");
  }

  return base + "\n" + userInstructions + roleBlocks + skillSnippets;
}

const execFileAsync = promisify(execFile);

// ── Redis keys ───────────────────────────────────────────────────────────────
const AGENT_DEF_KEY   = "konoha:agent-defs";    // hash: id → AgentDef JSON
const AGENT_STATE_KEY = "konoha:agent-states";   // hash: id → AgentState JSON
const AUDIT_STREAM    = "konoha:agent-audit";    // stream: lifecycle events

// ── Types ────────────────────────────────────────────────────────────────────

export type LifecycleStatus = "stopped" | "starting" | "running" | "stopping" | "error";

export interface AgentRedisStream {
  stream: string;    // Redis stream key, e.g. "telegram:incoming"
  group: string;     // Consumer group name, e.g. "sasuke"
  consumer?: string; // Consumer name (defaults to "{id}-lifecycle-watchdog")
}

export interface AgentDef {
  id: string;
  name: string;
  system_prompt?: string;
  model: string;
  env?: Record<string, string>;
  tags?: string[];
  capabilities?: string[];  // skill IDs assigned to this agent
  memory?: string;           // path to agent memory file (e.g. /opt/shared/agent-memory/{id}/MEMORY.md)
  avatar_url?: string;
  gender?: 'male' | 'female' | 'neutral';
  protected?: boolean;          // system agents — cannot be deleted, start/stop requires confirmation
  tmux_session_override?: string; // check this tmux session for live status instead of konoha-{id}
  redis_streams?: AgentRedisStream[]; // extra Redis streams to consume (e.g. telegram:incoming)
  created_at: string;
  updated_at: string;
}

export interface AgentState {
  agent_id: string;
  status: LifecycleStatus;
  pid?: number;
  started_at?: string;
  tmux_session?: string;
  error?: string;
  uptime_seconds?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** tmux session name — just the agent id (each agent gets its own socket via -L) */
function tmuxSession(id: string): string {
  return id;
}

/** tmux socket name — isolates each agent on its own tmux server */
function tmuxSocket(id: string): string {
  return id;
}

async function sh(cmd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args);
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (e: any) {
    return { ok: false, stdout: "", stderr: e.stderr?.trim() || e.message };
  }
}

export async function isTmuxRunning(id: string): Promise<boolean> {
  const r = await sh("tmux", ["-L", tmuxSocket(id), "has-session", "-t", tmuxSession(id)]);
  return r.ok;
}

async function getTmuxPid(id: string): Promise<number | null> {
  const r = await sh("tmux", ["-L", tmuxSocket(id), "list-panes", "-t", tmuxSession(id), "-F", "#{pane_pid}"]);
  if (!r.ok || !r.stdout) return null;
  const pid = parseInt(r.stdout.split("\n")[0], 10);
  return isNaN(pid) ? null : pid;
}

// ── MCP config helpers ───────────────────────────────────────────────────────

const GLOBAL_ENV_PATH = "/opt/konoha/.env.global";

function loadGlobalEnv(): Record<string, string> {
  if (!existsSync(GLOBAL_ENV_PATH)) return {};
  try {
    return readFileSync(GLOBAL_ENV_PATH, "utf-8")
      .split("\n")
      .filter(l => l.trim() && !l.startsWith("#") && l.includes("="))
      .reduce<Record<string, string>>((acc, line) => {
        const eq = line.indexOf("=");
        const key = line.slice(0, eq).trim();
        const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
        if (key) acc[key] = val;
        return acc;
      }, {});
  } catch {
    return {};
  }
}

function resolveVars(value: string, vars: Record<string, string>): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, key) => vars[key] ?? `\${${key}}`);
}

type McpServerDef = { name: string; command: string; args?: string[]; env?: Record<string, string> };
type ResolvedMcpServerDef = { command: string; args?: string[]; env?: Record<string, string> };
type McpConfig = { mcpServers: Record<string, ResolvedMcpServerDef> };

// Konoha MCP server is always included so agents can call konoha_register/send/read
// Use absolute path to bun — tmux server may not have ~/.bun/bin in PATH
const KONOHA_MCP_SERVER: McpServerDef & { name: string } = {
  name: "konoha",
  command: "/home/ubuntu/.bun/bin/bun",
  args: ["run", "/home/ubuntu/konoha/src/mcp.ts"],
  env: {
    KONOHA_URL: "${KONOHA_URL}",
    KONOHA_TOKEN: "${KONOHA_TOKEN}",
    no_proxy: "127.0.0.1,localhost",
  },
};

async function buildMcpConfig(
  capabilities: string[],
  agentEnv: Record<string, string>,
): Promise<McpConfig> {
  const globalEnv = loadGlobalEnv();
  const vars = { ...globalEnv, ...agentEnv };

  // Always start with Konoha MCP server
  const kEnv = Object.fromEntries(
    Object.entries(KONOHA_MCP_SERVER.env!).map(([k, v]) => [k, resolveVars(v, vars)])
  );
  // Pass agent capabilities as KONOHA_SKILLS so mcp.ts can enable skill-gated tools (#291)
  if (capabilities.length > 0) {
    kEnv["KONOHA_SKILLS"] = capabilities.join(",");
  }
  const servers: Record<string, ResolvedMcpServerDef> = {
    [KONOHA_MCP_SERVER.name]: {
      command: KONOHA_MCP_SERVER.command,
      args: KONOHA_MCP_SERVER.args,
      env: kEnv,
    },
  };

  for (const skillId of capabilities) {
    const raw = await redis.get(`konoha:skill:${skillId}`).catch(() => null);
    if (!raw) continue;
    const skill = JSON.parse(raw) as { mcp_servers?: McpServerDef[] };
    if (!skill.mcp_servers?.length) continue;
    for (const srv of skill.mcp_servers) {
      const resolvedEnv = srv.env
        ? Object.fromEntries(Object.entries(srv.env).map(([k, v]) => [k, resolveVars(v, vars)]))
        : undefined;
      const resolvedArgs = srv.args?.map(a => resolveVars(a, vars));
      servers[srv.name] = {
        command: resolveVars(srv.command, vars),
        ...(resolvedArgs?.length ? { args: resolvedArgs } : {}),
        ...(resolvedEnv && Object.keys(resolvedEnv).length ? { env: resolvedEnv } : {}),
      };
    }
  }

  return { mcpServers: servers };
}

function buildCodexMcpConfigArgs(mcpConfig: McpConfig): string[] {
  const args: string[] = [];
  for (const [name, server] of Object.entries(mcpConfig.mcpServers)) {
    const path = `mcp_servers.${configPathSegment(name)}`;
    args.push("-c", `${path}.command=${toToml(server.command)}`);
    if (server.args?.length) args.push("-c", `${path}.args=${toToml(server.args)}`);
    if (server.env && Object.keys(server.env).length) args.push("-c", `${path}.env=${toToml(server.env)}`);
  }
  return args;
}

function buildLaunchCommand(def: Pick<AgentDef, "model">, workdir: string, mcpConfigPath: string, mcpConfig: McpConfig): { provider: AgentProvider; command: string } {
  const runtime = resolveAgentRuntime(def.model);

  if (runtime.provider === "codex") {
    const args = [
      "codex",
      "--model", runtime.runtimeModel,
      "--dangerously-bypass-approvals-and-sandbox",
      "-C", workdir,
      ...buildCodexMcpConfigArgs(mcpConfig),
    ];
    return { provider: runtime.provider, command: args.map(shellEscape).join(" ") };
  }

  if (runtime.provider === "cursor") {
    const args = [
      "cursor-agent",
      "--yolo",
      "--approve-mcps",
      "--sandbox", "disabled",
      "--workspace", workdir,
    ];
    if (runtime.runtimeModel && runtime.runtimeModel !== "auto") {
      args.splice(1, 0, "--model", runtime.runtimeModel);
    }
    return { provider: runtime.provider, command: args.map(shellEscape).join(" ") };
  }

  const args = [
    "claude",
    "--model", runtime.runtimeModel,
    "--dangerously-skip-permissions",
    "--mcp-config", mcpConfigPath,
  ];
  return { provider: runtime.provider, command: args.map(shellEscape).join(" ") };
}

// ── State persistence ────────────────────────────────────────────────────────

async function saveState(state: AgentState): Promise<void> {
  // Strip computed uptime before persisting
  const { uptime_seconds: _u, ...toStore } = state;
  await redis.hset(AGENT_STATE_KEY, state.agent_id, JSON.stringify(toStore));
}

export async function getAgentState(id: string): Promise<AgentState> {
  const raw = await redis.hget(AGENT_STATE_KEY, id);
  const state: AgentState = raw ? JSON.parse(raw) : { agent_id: id, status: "stopped" };
  if (state.status === "running") {
    // Verify PID is still alive via /proc — auto-reset if dead (issue #276).
    // /proc/<pid> exists on Linux if and only if the process is alive.
    if (state.pid && !existsSync(`/proc/${state.pid}`)) {
      state.status = "stopped";
      state.pid = undefined;
      state.uptime_seconds = undefined;
      await saveState(state);
    } else if (state.started_at) {
      state.uptime_seconds = Math.floor((Date.now() - new Date(state.started_at).getTime()) / 1000);
    }
  }
  return state;
}

// ── Audit log ────────────────────────────────────────────────────────────────

async function audit(agent_id: string, action: string, detail?: string): Promise<void> {
  const fields: string[] = ["agent_id", agent_id, "action", action, "timestamp", new Date().toISOString()];
  if (detail) fields.push("detail", detail);
  await redis.xadd(AUDIT_STREAM, "*", ...fields);
}

// ── Agent definitions ────────────────────────────────────────────────────────

export async function createAgentDef(input: Omit<AgentDef, "created_at" | "updated_at">): Promise<AgentDef> {
  const now = new Date().toISOString();
  const def: AgentDef = { ...input, created_at: now, updated_at: now };
  await redis.hset(AGENT_DEF_KEY, def.id, JSON.stringify(def));
  await audit(def.id, "created");
  return def;
}

export async function getAgentDef(id: string): Promise<AgentDef | null> {
  const raw = await redis.hget(AGENT_DEF_KEY, id);
  return raw ? JSON.parse(raw) : null;
}

export async function deleteAgentDef(id: string): Promise<void> {
  await redis.hdel(AGENT_DEF_KEY, id);
  await redis.hdel(AGENT_STATE_KEY, id);
  await audit(id, "deleted");
}

export async function listAgentDefs(): Promise<AgentDef[]> {
  const all = await redis.hgetall(AGENT_DEF_KEY);
  return Object.values(all)
    .map(v => JSON.parse(v) as AgentDef)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

// ── Lifecycle operations ─────────────────────────────────────────────────────

export async function startAgent(id: string, def: AgentDef): Promise<AgentState> {
  const session = tmuxSession(id);
  const socket = tmuxSocket(id);

  // Already running — sync state and return
  if (await isTmuxRunning(id)) {
    const pid = await getTmuxPid(id);
    const existing = await getAgentState(id);
    const state: AgentState = {
      agent_id: id,
      status: "running",
      pid: pid ?? undefined,
      started_at: existing.started_at ?? new Date().toISOString(),
      tmux_session: session,
    };
    await saveState(state);
    return await getAgentState(id);
  }

  await saveState({ agent_id: id, status: "starting", tmux_session: session });

  try {
    // Prepare per-agent working directory with two-level CLAUDE.md
    const workdir = join(AGENT_WORKDIR_ROOT, id);
    mkdirSync(workdir, { recursive: true });

    const claudeMd = await buildSystemPrompt(id, def);
    writeFileSync(join(workdir, "CLAUDE.md"), claudeMd, "utf-8");
    writeFileSync(join(workdir, "AGENTS.md"), claudeMd, "utf-8");

    // Build MCP configs for supported runtimes.
    const mcpConfig = await buildMcpConfig(def.capabilities ?? [], def.env ?? {});
    const mcpConfigPath = join(workdir, ".mcp.json");
    writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), "utf-8");

    const cursorConfigDir = join(workdir, ".cursor");
    mkdirSync(cursorConfigDir, { recursive: true });
    writeFileSync(join(cursorConfigDir, "mcp.json"), JSON.stringify(mcpConfig, null, 2), "utf-8");

    const launch = buildLaunchCommand(def, workdir, mcpConfigPath, mcpConfig);
    if (launch.provider === "codex") ensureCodexProjectTrusted(workdir);

    // Build env prefix if custom env vars provided
    const envPrefix = def.env ? Object.entries(def.env).map(([k, v]) => `${k}=${shellEscape(v)}`).join(" ") + " " : "";
    const runtimeCmd = envPrefix ? `env ${envPrefix}${launch.command}` : launch.command;

    // Wrap in restart loop — without it the interactive CLI may exit after startup or on crash.
    const loopScript = `export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$PATH"; while true; do ${runtimeCmd}; echo "[$(date)] ${launch.provider} exited (code $?), restarting in 5s..."; sleep 5; done`;

    // Use named socket (-L) to isolate each agent on its own tmux server.
    // If one tmux server crashes, only that agent is affected — not all lifecycle agents.
    const r = await sh("tmux", ["-L", socket, "new-session", "-d", "-s", session, "-x", "200", "-y", "50", "-c", workdir, "bash", "-c", loopScript]);
    if (!r.ok) throw new Error(r.stderr || "tmux new-session failed");

    // Wait for the interactive CLI to boot and become ready.
    await new Promise(res => setTimeout(res, 7000));

    // Cursor requires an explicit one-key workspace trust on first launch.
    if (launch.provider === "cursor") {
      await sh("tmux", ["-L", socket, "send-keys", "-t", session, "a"]);
      await new Promise(res => setTimeout(res, 1200));
    }

    // Inject startup message so agent executes its startup sequence.
    await sh("tmux", ["-L", socket, "send-keys", "-t", session, "Прочитай CLAUDE.md и выполни startup sequence."]);
    await new Promise(res => setTimeout(res, 350));
    await sh("tmux", ["-L", socket, "send-keys", "-t", session, "Enter"]);

    const pid = await getTmuxPid(id);
    const state: AgentState = {
      agent_id: id,
      status: "running",
      pid: pid ?? undefined,
      started_at: new Date().toISOString(),
      tmux_session: session,
    };
    await saveState(state);
    await audit(id, "started", `socket=${socket} session=${session} pid=${pid}`);
    return await getAgentState(id);
  } catch (e: any) {
    const state: AgentState = { agent_id: id, status: "error", error: e.message };
    await saveState(state);
    await audit(id, "error", e.message);
    throw e;
  }
}

export async function stopAgent(id: string): Promise<AgentState> {
  const session = tmuxSession(id);
  const socket = tmuxSocket(id);
  await saveState({ agent_id: id, status: "stopping", tmux_session: session });

  try {
    if (await isTmuxRunning(id)) {
      // Try graceful stop via Claude Code /exit command
      await sh("tmux", ["-L", socket, "send-keys", "-t", session, "/exit", "Enter"]);
      await new Promise(res => setTimeout(res, 1200));

      // Force kill if still alive
      if (await isTmuxRunning(id)) {
        await sh("tmux", ["-L", socket, "kill-session", "-t", session]);
      }
    }

    const state: AgentState = { agent_id: id, status: "stopped" };
    await saveState(state);
    await audit(id, "stopped");
    return state;
  } catch (e: any) {
    const state: AgentState = { agent_id: id, status: "error", error: e.message };
    await saveState(state);
    await audit(id, "error", e.message);
    throw e;
  }
}

export async function restartAgent(id: string, def: AgentDef): Promise<AgentState> {
  await stopAgent(id).catch(() => {});
  await audit(id, "restarted");
  return startAgent(id, def);
}
