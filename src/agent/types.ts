/**
 * agent/types.ts — Shared type definitions for the agent module.
 * Extracted from agent-lifecycle.ts (#509).
 */

export type AgentProvider = "claude" | "codex" | "cursor" | "glm";
export type LaunchStrategy = "persistent_interactive" | "headless_task";
export type AgentSeedClassification =
  | "core"
  | "optional_worker"
  | "connector_owned"
  | "deprecated_compat"
  | "out_of_scope";
export type AgentLifecycleMode =
  | "core"
  | "optional_on_demand"
  | "connector_owned"
  | "deprecated";
export type AgentDisplaySource = "org_override" | "locale_catalog" | "neutral_default";

export type LifecycleStatus = "stopped" | "starting" | "running" | "stopping" | "error";

export interface AgentRedisStream {
  stream: string;    // Redis stream key, e.g. "telegram:incoming"
  group: string;     // Consumer group name, e.g. "sasuke"
  consumer?: string; // Consumer name (defaults to "{id}-lifecycle-watchdog")
}

export interface ToolProfile {
  id: string;
  name: string;
  mcp_servers: string[];
  scopes: ("read" | "write" | "execute")[];
  dangerous_tools?: string[];
  notes?: string;
}

export type SandboxType = "tmux" | "process" | "docker" | "remote";

export interface SandboxProfile {
  id: string;
  type: SandboxType;
  config?: Record<string, string>;
}

export interface AgentRuntimeProfile {
  runtime: AgentProvider;
  model: string;
  codex_disable_features?: string[];
}

export interface AgentDef {
  id: string;
  name: string;
  /** Mutable instance-specific alias/callsign; canonical product name stays in name. */
  display_alias?: string;
  system_prompt?: string;
  system_prompt_hash?: string;
  system_prompt_updated_at?: string;
  system_prompt_updated_by?: string;
  rendered_prompt_hash?: string;
  rendered_prompt_updated_at?: string;
  rendered_prompt_path?: string;
  startup_sequence?: string[];
  runtime?: AgentProvider;
  fallback_runtime?: AgentProvider;
  launch_strategy?: LaunchStrategy;
  startup_timeout_sec?: number;
  model: string;
  llm_client_profile?: string; // runtime adapter + provider + model profile, e.g. "claude-deepseek-opus"
  fallback_llm_client_profile?: string;
  reasoning_effort?: string;   // e.g. "high", "medium", "low" — provider-specific
  env?: Record<string, string>;
  tags?: string[];
  /** ADR-004 seed classification for compatibility/runtime actors. */
  seed_classification?: AgentSeedClassification;
  /** Product-facing lifecycle mode, separate from runtime launch strategy. */
  lifecycle_mode?: AgentLifecycleMode;
  capabilities?: string[];  // skill IDs assigned to this agent
  tool_profile?: string;        // ToolProfile id (#571)
  sandbox_profile?: string;     // SandboxProfile id (#572), defaults to "tmux"
  shared_mcp_allowlist?: string[]; // optional subset of shared MCP servers to include
  codex_disable_features?: string[]; // optional per-agent Codex feature disables
  runtime_profiles?: Record<string, AgentRuntimeProfile>; // legacy named runtime presets
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

export interface AgentTemplate {
  id: string;
  name: string;
  display_alias?: string;
  system_prompt?: string;
  system_prompt_hash?: string;
  system_prompt_updated_at?: string;
  system_prompt_updated_by?: string;
  rendered_prompt_hash?: string;
  rendered_prompt_updated_at?: string;
  rendered_prompt_path?: string;
  tool_profile?: string;        // ToolProfile id (#571)
  sandbox_profile?: string;     // SandboxProfile id (#572), defaults to "tmux"
  tags?: string[];
  seed_classification?: AgentSeedClassification;
  lifecycle_mode?: AgentLifecycleMode;
  capabilities?: string[];
  memory?: string;
  avatar_url?: string;
  gender?: 'male' | 'female' | 'neutral';
  protected?: boolean;
  created_at: string;
  updated_at: string;
}

export interface AgentDisplayProjection {
  name: string;
  alias?: string;
  locale: string;
  source: {
    name: AgentDisplaySource;
    alias?: AgentDisplaySource;
  };
}

export interface AgentRuntimeConfig {
  runtime?: AgentProvider;
  fallback_runtime?: AgentProvider;
  llm_client_profile?: string;
  fallback_llm_client_profile?: string;
  launch_strategy?: LaunchStrategy;
  startup_timeout_sec?: number;
  model: string;
  reasoning_effort?: string;
  env?: Record<string, string>;
  shared_mcp_allowlist?: string[];
  codex_disable_features?: string[];
  tmux_session_override?: string;
  redis_streams?: AgentRedisStream[];
}

export interface AgentPresence {
  agent_id: string;
  status: "online" | "offline";
  online: boolean;
  last_heartbeat?: number;
  address?: string;
  village_id?: string;
  event_subscriptions?: string[];
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

export type AgentRuntimeState = AgentState;

export interface AgentView extends AgentDef {
  display?: AgentDisplayProjection;
  presence?: AgentPresence;
  runtime_config: AgentRuntimeConfig;
  template: AgentTemplate;
  runtime_state: AgentRuntimeState;
  active_runtime_profile?: string;
  fallback_runtime_profile?: string;
  auto_runtime_fallback: boolean;
  lifecycle: {
    status: LifecycleStatus | string;
    pid?: number;
    uptime_seconds?: number;
  };
}
