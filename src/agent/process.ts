/**
 * agent/process.ts — tmux process management, state persistence, audit logging.
 * Extracted from agent-lifecycle.ts (#509).
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { redis } from "../redis";
import { silentCatch } from "../logger";
import { buildSystemPrompt } from "./prompt";
import { buildMcpConfig, buildLaunchCommand, shellEscape, ensureCodexProjectTrusted, getLiveBitrixWebhook } from "./runtime";
import { AGENT_WORKDIR_ROOT } from "./runtime";
import type { AgentDef, AgentState, LifecycleStatus } from "./types";

const execFileAsync = promisify(execFile);

const INSTRUCTIONS_FILE = "AGENTS.md";

// ── Redis keys ───────────────────────────────────────────────────────────────
const AGENT_STATE_KEY = "konoha:agent-states";   // hash: id → AgentState JSON
const AUDIT_STREAM    = "konoha:agent-audit";    // stream: lifecycle events

// ── tmux helpers ─────────────────────────────────────────────────────────────

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
    const tmuxAlive = await isTmuxRunning(id);
    // A missing tmux session means the interactive agent is gone even if a stale
    // pid was persisted or the pid field was never written.
    if (!tmuxAlive || (state.pid && !existsSync(`/proc/${state.pid}`))) {
      state.status = "stopped";
      state.pid = undefined;
      state.uptime_seconds = undefined;
      state.tmux_session = undefined;
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
    // Prepare per-agent working directory with AGENTS.md instructions only.
    const workdir = join(AGENT_WORKDIR_ROOT, id);
    mkdirSync(workdir, { recursive: true });

    const instructions = await buildSystemPrompt(id, def);
    writeFileSync(join(workdir, INSTRUCTIONS_FILE), instructions, "utf-8");

    // Build MCP configs for supported runtimes.
    const mcpConfig = await buildMcpConfig(
      def.capabilities ?? [],
      def.env ?? {},
      def.shared_mcp_allowlist,
    );
    const liveBitrixWebhook = getLiveBitrixWebhook();
    const bitrixServer = mcpConfig.mcpServers.bitrix24;
    if (liveBitrixWebhook && bitrixServer && "command" in bitrixServer) {
      bitrixServer.env = { ...(bitrixServer.env ?? {}), BITRIX24_WEBHOOK_URL: liveBitrixWebhook };
    }
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
    const loopScript = `export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$HOME/.bun/bin:$PATH"; while true; do ${runtimeCmd}; echo "[$(date)] ${launch.provider} exited (code $?), restarting in 5s..."; sleep 5; done`;

    // Use named socket (-L) to isolate each agent on its own tmux server.
    // If one tmux server crashes, only that agent is affected — not all lifecycle agents.
    const r = await sh("tmux", ["-L", socket, "new-session", "-d", "-s", session, "-x", "200", "-y", "50", "-c", workdir, "bash", "-c", loopScript]);
    if (!r.ok) throw new Error(r.stderr || "tmux new-session failed");

    // Wait for the interactive CLI to boot and become ready.
    await new Promise(res => setTimeout(res, 7000));

    // Cursor requires an explicit one-key workspace trust only on first launch.
    if (launch.provider === "cursor") {
      const pane = await sh("tmux", ["-L", socket, "capture-pane", "-p", "-t", session, "-S", "-80"]);
      if (pane.ok && pane.stdout.includes("Workspace Trust Required")) {
        await sh("tmux", ["-L", socket, "send-keys", "-t", session, "a"]);
        await new Promise(res => setTimeout(res, 3500));
      }
    }

    // Inject startup message so agent executes its startup sequence.
    await sh("tmux", ["-L", socket, "send-keys", "-t", session, "Прочитай AGENTS.md и выполни startup sequence."]);
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
  await stopAgent(id).catch(silentCatch("stop agent on delete"));
  await audit(id, "restarted");
  return startAgent(id, def);
}
