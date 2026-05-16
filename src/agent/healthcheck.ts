/**
 * agent/healthcheck.ts — Per-agent healthcheck using pane analysis.
 *
 * Complements the Python check_agents() in scripts/healthcheck-system.py
 * by exposing the same pane-inspection logic to TypeScript callers.
 */

import { isTmuxRunning, getAgentState } from "./process";
import { checkAgentPromptMirrorDrift, type PromptMirrorDriftResult } from "./prompt-drift";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface HealthcheckResult {
  healthy: boolean;
  signal?: "stuck_paste" | "compacting" | "rate_limit" | "permission_prompt" | "missing_tmux" | "pane_unreadable" | "prompt_mirror_drift";
  detail: string;
  profile?: string;
  prompt_mirror?: PromptMirrorDriftResult;
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
  const promptMirror = await checkAgentPromptMirrorDrift(agentId).catch(() => undefined);
  const tmuxAlive = await isTmuxRunning(agentId);
  if (!tmuxAlive) {
    return {
      healthy: false,
      signal: "missing_tmux",
      detail: `tmux session ${agentId} not found`,
      prompt_mirror: promptMirror,
    };
  }

  const pane = await captureTmuxPane(agentId);
  if (pane === null) {
    return {
      healthy: false,
      signal: "pane_unreadable",
      detail: `failed to capture pane for ${agentId}`,
      prompt_mirror: promptMirror,
    };
  }

  const stuckSignal = paneStuckSignal(pane);
  if (stuckSignal) {
    return {
      healthy: false,
      signal: stuckSignal as HealthcheckResult["signal"],
      detail: `agent ${agentId} pane signal: ${stuckSignal}`,
      prompt_mirror: promptMirror,
    };
  }

  const idle = paneIsIdle(pane);
  const state = await getAgentState(agentId);

  return {
    healthy: !promptMirror || promptMirror.status === "ok",
    signal: promptMirror && promptMirror.status !== "ok" ? "prompt_mirror_drift" : undefined,
    detail: promptMirror && promptMirror.status !== "ok"
      ? `agent ${agentId} prompt mirror ${promptMirror.status}`
      : `alive idle=${idle} pid=${state.pid ?? "?"} uptime=${state.uptime_seconds ?? "?"}s`,
    prompt_mirror: promptMirror,
  };
}
