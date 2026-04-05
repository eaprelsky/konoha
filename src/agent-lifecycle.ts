/**
 * agent-lifecycle.ts — Agent definition store + process lifecycle management.
 * Separate from the bus registry (redis.ts) which tracks message-routing status.
 *
 * Stores persistent agent definitions and manages OS-level start/stop via tmux.
 */

import { redis } from "./redis";
import { execFile } from "child_process";
import { promisify } from "util";
import { randomUUID } from "crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";

const AGENT_WORKDIR_ROOT = "/opt/shared/agent-workdirs";

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
    .replace(/{{model}}/g, def.model || "claude-sonnet-4-6");
}

const execFileAsync = promisify(execFile);

// ── Redis keys ───────────────────────────────────────────────────────────────
const AGENT_DEF_KEY   = "konoha:agent-defs";    // hash: id → AgentDef JSON
const AGENT_STATE_KEY = "konoha:agent-states";   // hash: id → AgentState JSON
const AUDIT_STREAM    = "konoha:agent-audit";    // stream: lifecycle events

// ── Types ────────────────────────────────────────────────────────────────────

export type LifecycleStatus = "stopped" | "starting" | "running" | "stopping" | "error";

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

function tmuxSession(id: string): string {
  return "konoha-" + id;
}

async function sh(cmd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args);
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (e: any) {
    return { ok: false, stdout: "", stderr: e.stderr?.trim() || e.message };
  }
}

export async function isTmuxRunning(session: string): Promise<boolean> {
  const r = await sh("tmux", ["has-session", "-t", session]);
  return r.ok;
}

async function getTmuxPid(session: string): Promise<number | null> {
  const r = await sh("tmux", ["list-panes", "-t", session, "-F", "#{pane_pid}"]);
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
): Promise<Record<string, unknown>> {
  const globalEnv = loadGlobalEnv();
  const vars = { ...globalEnv, ...agentEnv };

  // Always start with Konoha MCP server
  const kEnv = Object.fromEntries(
    Object.entries(KONOHA_MCP_SERVER.env!).map(([k, v]) => [k, resolveVars(v, vars)])
  );
  const servers: Record<string, unknown> = {
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

// ── State persistence ────────────────────────────────────────────────────────

async function saveState(state: AgentState): Promise<void> {
  // Strip computed uptime before persisting
  const { uptime_seconds: _u, ...toStore } = state;
  await redis.hset(AGENT_STATE_KEY, state.agent_id, JSON.stringify(toStore));
}

export async function getAgentState(id: string): Promise<AgentState> {
  const raw = await redis.hget(AGENT_STATE_KEY, id);
  const state: AgentState = raw ? JSON.parse(raw) : { agent_id: id, status: "stopped" };
  if (state.status === "running" && state.started_at) {
    state.uptime_seconds = Math.floor((Date.now() - new Date(state.started_at).getTime()) / 1000);
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

  // Already running — sync state and return
  if (await isTmuxRunning(session)) {
    const pid = await getTmuxPid(session);
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
    const claudeMd = renderSystemTemplate(def) + "\n" + (def.system_prompt?.trim() || "") + skillSnippets;
    writeFileSync(join(workdir, "CLAUDE.md"), claudeMd, "utf-8");

    // Build .mcp.json — always includes Konoha MCP server + any skill mcp_servers
    const mcpConfig = await buildMcpConfig(def.capabilities ?? [], def.env ?? {});
    const mcpConfigPath = join(workdir, ".mcp.json");
    writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), "utf-8");
    const mcpConfigFlag = ["--mcp-config", mcpConfigPath];

    const modelFlag = def.model ? ["--model", def.model] : [];
    const launchCmd = ["claude", ...modelFlag, ...mcpConfigFlag].join(" ");

    // Build env prefix if custom env vars provided
    const envVars = def.env ? Object.entries(def.env).map(([k, v]) => `${k}=${v}`).join(" ") + " " : "";
    const fullCmd = envVars ? `env ${envVars}${launchCmd}` : launchCmd;

    const r = await sh("tmux", ["new-session", "-d", "-s", session, "-c", workdir, fullCmd]);
    if (!r.ok) throw new Error(r.stderr || "tmux new-session failed");

    // Wait for Claude Code to start and show the prompt
    await new Promise(res => setTimeout(res, 3000));

    // Inject startup message so agent executes its startup sequence
    await sh("tmux", ["send-keys", "-t", session, "Прочитай CLAUDE.md и выполни startup sequence.", "Enter"]);

    const pid = await getTmuxPid(session);
    const state: AgentState = {
      agent_id: id,
      status: "running",
      pid: pid ?? undefined,
      started_at: new Date().toISOString(),
      tmux_session: session,
    };
    await saveState(state);
    await audit(id, "started", `session=${session} pid=${pid}`);
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
  await saveState({ agent_id: id, status: "stopping", tmux_session: session });

  try {
    if (await isTmuxRunning(session)) {
      // Try graceful stop via Claude Code /exit command
      await sh("tmux", ["send-keys", "-t", session, "/exit", "Enter"]);
      await new Promise(res => setTimeout(res, 1200));

      // Force kill if still alive
      if (await isTmuxRunning(session)) {
        await sh("tmux", ["kill-session", "-t", session]);
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
