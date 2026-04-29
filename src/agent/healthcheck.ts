/**
 * agent/healthcheck.ts — Per-agent healthcheck using pane analysis.
 *
 * Complements the Python check_agents() in scripts/healthcheck-system.py
 * by exposing the same pane-inspection logic to TypeScript callers.
 */

import { isTmuxRunning, getAgentState } from "./process";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface HealthcheckResult {
  healthy: boolean;
  signal?: "stuck_paste" | "compacting" | "rate_limit" | "permission_prompt" | "missing_tmux" | "pane_unreadable";
  detail: string;
  profile?: string;
}

function paneIsIdle(content: string): boolean {
  const lines = content
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean);
  const last = lines.slice(-12);
  return (
    last.some(l => (l === "❯" || l.startsWith("❯ ") || l.startsWith("› ")) && !l.includes("Pasted text"))
    || last.some(l => l.includes("ctrl+p commands") || l.includes("tab agents"))
    || last.some(l => l.includes("→ Add a follow-up") || l.includes("ctrl+c to stop"))
  );
}

function paneStuckSignal(content: string): string {
  const tail = content
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean)
    .slice(-20)
    .join("\n");
  const lowered = tail.toLowerCase();
  if (tail.includes("Pasted text")) return "stuck_paste";
  if (lowered.includes("compacting") || lowered.includes("compact")) return "compacting";
  if (lowered.includes("rate limit")) return "rate_limit";
  for (const line of lowered.split("\n")) {
    if (line.includes("permission") && (line.includes("allow") || line.includes("approve")) && !line.includes("bypass permissions on")) {
      return "permission_prompt";
    }
  }
  return "";
}

async function captureTmuxPane(agentId: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("tmux", [
      "-L", agentId, "capture-pane", "-pt", agentId, "-S", "-80",
    ], { timeout: 5000 });
    return stdout;
  } catch {
    return null;
  }
}

export async function healthcheckAgent(agentId: string): Promise<HealthcheckResult> {
  const tmuxAlive = await isTmuxRunning(agentId);
  if (!tmuxAlive) {
    return {
      healthy: false,
      signal: "missing_tmux",
      detail: `tmux session ${agentId} not found`,
    };
  }

  const pane = await captureTmuxPane(agentId);
  if (pane === null) {
    return {
      healthy: false,
      signal: "pane_unreadable",
      detail: `failed to capture pane for ${agentId}`,
    };
  }

  const stuckSignal = paneStuckSignal(pane);
  if (stuckSignal) {
    return {
      healthy: false,
      signal: stuckSignal as HealthcheckResult["signal"],
      detail: `agent ${agentId} pane signal: ${stuckSignal}`,
    };
  }

  const idle = paneIsIdle(pane);
  const state = await getAgentState(agentId);

  return {
    healthy: true,
    detail: `alive idle=${idle} pid=${state.pid ?? "?"} uptime=${state.uptime_seconds ?? "?"}s`,
  };
}
