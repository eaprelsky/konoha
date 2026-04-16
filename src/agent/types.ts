/**
 * agent/types.ts — Shared type definitions for the agent module.
 * Extracted from agent-lifecycle.ts (#509).
 */

export type AgentProvider = "claude" | "codex" | "cursor" | "glm";
export type LaunchStrategy = "persistent_interactive" | "headless_task";

export type LifecycleStatus = "stopped" | "starting" | "running" | "stopping" | "error";

export interface AgentRedisStream {
  stream: string;    // Redis stream key, e.g. "telegram:incoming"
  group: string;     // Consumer group name, e.g. "sasuke"
  consumer?: string; // Consumer name (defaults to "{id}-lifecycle-watchdog")
}

export interface AgentRuntimeProfile {
  runtime: AgentProvider;
  model: string;
  codex_disable_features?: string[];
}

export interface AgentDef {
  id: string;
  name: string;
  system_prompt?: string;
  startup_sequence?: string[];
  runtime?: AgentProvider;
  fallback_runtime?: AgentProvider;
  launch_strategy?: LaunchStrategy;
  startup_timeout_sec?: number;
  model: string;
  env?: Record<string, string>;
  tags?: string[];
  capabilities?: string[];  // skill IDs assigned to this agent
  shared_mcp_allowlist?: string[]; // optional subset of shared MCP servers to include
  codex_disable_features?: string[]; // optional per-agent Codex feature disables
  runtime_profiles?: Record<string, AgentRuntimeProfile>;
  active_runtime_profile?: string;
  fallback_runtime_profile?: string;
  auto_runtime_fallback?: boolean;
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
