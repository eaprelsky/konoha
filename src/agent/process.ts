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
import { recordRenderedPromptMirror } from "./crud";
import { buildMcpConfigWithReceipt, buildLaunchCommand, shellEscape, ensureCodexProjectTrusted, getLiveBitrixWebhook } from "./runtime";
import { AGENT_WORKDIR_ROOT } from "./runtime";
import { buildAgentSystemdScopeCommand, systemdScopesEnabled } from "./systemd-slices";
import { assertCodexEgressProxy } from "./proxy-policy";
import { resolveSharedMcpAllowlist } from "./tool-profiles";
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

/** Agents that use the default tmux socket instead of isolated per-agent sockets.
 *  NOTE: sasuke and kiba were previously here but actually use named sockets
 *  (-L sasuke, -L kiba) via agent-api-service.sh. Including them caused
 *  tmux -L "" which resolves to /tmp/tmux-1000/ (a directory), breaking restarts. */
const DEFAULT_SOCKET_AGENTS = new Set<string>([]);

/** tmux socket name — isolates each agent on its own tmux server.
 *  Returns empty string for agents that should use the default tmux socket. */
function tmuxSocket(id: string): string {
  return DEFAULT_SOCKET_AGENTS.has(id) ? "" : id;
}

/** Build tmux args, conditionally including -L <socket> */
function tmuxArgs(id: string, ...args: string[]): string[] {
  const socket = tmuxSocket(id);
  return socket ? ["-L", socket, ...args] : args;
}

async function sh(cmd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args);
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (e: any) {
    return { ok: false, stdout: "", stderr: e.stderr?.trim() || e.message };
  }
}

async function startTmuxSessionInScope(id: string, def: AgentDef, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string; detail: string }> {
  if (!systemdScopesEnabled()) {
    const r = await sh("tmux", args);
    return { ...r, detail: "scope=disabled" };
  }
  const scoped = buildAgentSystemdScopeCommand(id, def, "tmux", args);
  const r = await sh(scoped.cmd, scoped.args);
  return { ...r, detail: `scope=${scoped.unit}.scope slice=${scoped.policy.slice}` };
}

export async function isTmuxRunning(id: string): Promise<boolean> {
  const r = await sh("tmux", tmuxArgs(id, "has-session", "-t", tmuxSession(id)));
  return r.ok;
}

async function getTmuxPid(id: string): Promise<number | null> {
  const r = await sh("tmux", tmuxArgs(id, "list-panes", "-t", tmuxSession(id), "-F", "#{pane_pid}"));
  if (!r.ok || !r.stdout) return null;
  const pid = parseInt(r.stdout.split("\n")[0], 10);
  return isNaN(pid) ? null : pid;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function paneIsIdle(content: string): boolean {
  const lines = content
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);
  const lastLines = lines.slice(-12);
  const hasClaudeQueue = lastLines.some(line => line.toLowerCase().includes("queued messages"));
  const hasClaudePrompt = lastLines.some(line => (
    (line === "❯" || line === "❯\xa0" || line.startsWith("❯ ") || line.startsWith("❯\xa0"))
    && !line.includes("Pasted text")
  )) && !hasClaudeQueue;
  const hasCodexStartup = lastLines.some(line => line.includes("Booting MCP server") || line.includes("Starting MCP servers"));
  const hasCodexPrompt = lastLines.some(line => line.startsWith("› ")) && !hasCodexStartup;
  const hasCursorReady = lastLines.some(line => line.includes("→ Add a follow-up"))
    || lastLines.some(line => line.includes("ctrl+c to stop"))
    || lastLines.some(line => line.includes("▶︎ Auto-run everything"));
  const hasOpencodeIdle = lastLines.some(line => line.includes("ctrl+p commands"))
    || lastLines.some(line => line.includes("tab agents"));
  return hasClaudePrompt || hasCodexPrompt || hasCursorReady || hasOpencodeIdle;
}

async function getTmuxPaneContent(id: string, lines = 80): Promise<string> {
  const r = await sh("tmux", tmuxArgs(id, "capture-pane", "-p", "-t", tmuxSession(id), "-S", `-${lines}`));
  return r.ok ? r.stdout : "";
}

async function waitForIdlePrompt(id: string, timeoutMs = 45000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isTmuxRunning(id))) return false;
    const pane = await getTmuxPaneContent(id);
    if (pane.trim() && paneIsIdle(pane)) return true;
    await sleep(500);
  }
  return false;
}

async function dismissPastedDialog(id: string): Promise<void> {
  const session = tmuxSession(id);
  const socket = tmuxSocket(id);
  for (let attempt = 0; attempt < 5; attempt++) {
    const pane = await getTmuxPaneContent(id);
    if (!pane.includes("Pasted text")) return;
    await sh("tmux", ["-L", socket, "send-keys", "-t", session, "Enter"]);
    await sleep(600);
  }
}

async function confirmSubmitted(id: string, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isTmuxRunning(id))) return false;
    const pane = await getTmuxPaneContent(id);
    if (pane.includes("Pasted text")) {
      await dismissPastedDialog(id);
      continue;
    }
    if (pane.trim() && !paneIsIdle(pane)) return true;
    await sleep(400);
  }
  return false;
}

async function retypeStartupPrompt(id: string, text: string): Promise<void> {
  const session = tmuxSession(id);
  const socket = tmuxSocket(id);
  await sh("tmux", ["-L", socket, "send-keys", "-t", session, "C-u"]);
  await sleep(150);
  const typed = await sh("tmux", ["-L", socket, "send-keys", "-t", session, text]);
  if (!typed.ok) throw new Error(typed.stderr || `failed to retype startup prompt for ${id}`);
  await sleep(350);
  await dismissPastedDialog(id);
}

async function sendStartupPrompt(id: string, text: string): Promise<void> {
  const session = tmuxSession(id);
  const socket = tmuxSocket(id);

  const ready = await waitForIdlePrompt(id, 45000);
  if (!ready && !(await isTmuxRunning(id))) {
    throw new Error(`tmux session ${id} disappeared before startup prompt`);
  }

  const typed = await sh("tmux", ["-L", socket, "send-keys", "-t", session, text]);
  if (!typed.ok) throw new Error(typed.stderr || `failed to type startup prompt for ${id}`);
  await sleep(350);
  await dismissPastedDialog(id);

  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt >= 2) {
      await retypeStartupPrompt(id, text);
    }

    await sh("tmux", ["-L", socket, "send-keys", "-t", session, "Enter"]);
    if (await confirmSubmitted(id, attempt === 0 ? 4500 : 3500)) return;
  }

  await sh("tmux", ["-L", socket, "send-keys", "-t", session, "C-u"]);
  console.warn(`[agent:${id}] startup prompt stayed idle after submit retries; continuing startup without blocking agent launch`);
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
    const instructionsPath = join(workdir, INSTRUCTIONS_FILE);
    writeFileSync(instructionsPath, instructions, "utf-8");
    await recordRenderedPromptMirror(id, instructions, instructionsPath);

    // Build MCP configs for supported runtimes.
    const { config: mcpConfig, receipt: mcpReceipt } = await buildMcpConfigWithReceipt(
      def.capabilities ?? [],
      def.env ?? {},
      resolveSharedMcpAllowlist(def.shared_mcp_allowlist, def.tool_profile),
    );
    const liveBitrixWebhook = getLiveBitrixWebhook();
    const bitrixServer = mcpConfig.mcpServers.bitrix24;
    if (liveBitrixWebhook && bitrixServer && "command" in bitrixServer) {
      bitrixServer.env = { ...(bitrixServer.env ?? {}), BITRIX24_WEBHOOK_URL: liveBitrixWebhook };
    }
    const mcpConfigPath = join(workdir, ".mcp.json");
    writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), "utf-8");
    writeFileSync(join(workdir, "mcp-pack-receipt.json"), JSON.stringify(mcpReceipt, null, 2), "utf-8");

    const cursorConfigDir = join(workdir, ".cursor");
    mkdirSync(cursorConfigDir, { recursive: true });
    writeFileSync(join(cursorConfigDir, "mcp.json"), JSON.stringify(mcpConfig, null, 2), "utf-8");

    const launch = buildLaunchCommand(def, workdir, mcpConfigPath, mcpConfig);
    if (launch.provider === "codex") {
      assertCodexEgressProxy();
      ensureCodexProjectTrusted(workdir);
    }

    // Build env prefix if custom env vars provided
    const envPrefix = def.env ? Object.entries(def.env).map(([k, v]) => `${k}=${shellEscape(v)}`).join(" ") + " " : "";
    const runtimeCmd = envPrefix ? `env ${envPrefix}${launch.command}` : launch.command;

    // Wrap in restart loop — without it the interactive CLI may exit after startup or on crash.
    const loopScript = `export PATH="$HOME/.bun/bin:$HOME/.npm-global/bin:$HOME/.local/bin:$PATH"; while true; do ${runtimeCmd}; echo "[$(date)] ${launch.provider} exited (code $?), restarting in 5s..."; sleep 5; done`;

    // Use named socket (-L) to isolate each agent on its own tmux server.
    // If one tmux server crashes, only that agent is affected — not all lifecycle agents.
    const r = await startTmuxSessionInScope(id, def, ["-L", socket, "new-session", "-d", "-s", session, "-x", "200", "-y", "50", "-c", workdir, "bash", "-c", loopScript]);
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
    await sendStartupPrompt(id, "Прочитай AGENTS.md и выполни startup sequence.");
    if (!(await isTmuxRunning(id))) {
      throw new Error(`tmux session ${id} disappeared during startup`);
    }

    const pid = await getTmuxPid(id);
    const state: AgentState = {
      agent_id: id,
      status: "running",
      pid: pid ?? undefined,
      started_at: new Date().toISOString(),
      tmux_session: session,
    };
    await saveState(state);
    await audit(id, "started", `socket=${socket} session=${session} pid=${pid} ${r.detail}`);
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
