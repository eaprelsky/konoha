import type { Agent } from "../redis";
import type { AgentDef, AgentPresence, AgentRuntimeConfig, AgentRuntimeState, AgentTemplate, AgentView } from "./types";
import { getLLMClientProfile } from "./llm-client-profiles";

type LegacyBase = Partial<Agent> & { id: string; status?: Agent["status"] };

export function templateFromAgentDef(def: AgentDef): AgentTemplate {
  return {
    id: def.id,
    name: def.name,
    display_alias: def.display_alias,
    system_prompt: def.system_prompt,
    system_prompt_hash: def.system_prompt_hash,
    system_prompt_updated_at: def.system_prompt_updated_at,
    system_prompt_updated_by: def.system_prompt_updated_by,
    rendered_prompt_hash: def.rendered_prompt_hash,
    rendered_prompt_updated_at: def.rendered_prompt_updated_at,
    rendered_prompt_path: def.rendered_prompt_path,
    tool_profile: def.tool_profile,
    sandbox_profile: def.sandbox_profile,
    tags: def.tags,
    seed_classification: def.seed_classification,
    lifecycle_mode: def.lifecycle_mode,
    capabilities: def.capabilities,
    memory: def.memory,
    avatar_url: def.avatar_url,
    gender: def.gender,
    protected: def.protected,
    created_at: def.created_at,
    updated_at: def.updated_at,
  };
}

export function runtimeConfigFromAgentDef(def: AgentDef): AgentRuntimeConfig {
  return {
    runtime: def.runtime,
    fallback_runtime: def.fallback_runtime,
    llm_client_profile: def.llm_client_profile,
    fallback_llm_client_profile: def.fallback_llm_client_profile,
    launch_strategy: def.launch_strategy,
    startup_timeout_sec: def.startup_timeout_sec,
    model: def.model,
    reasoning_effort: def.reasoning_effort,
    env: def.env,
    shared_mcp_allowlist: def.shared_mcp_allowlist,
    codex_disable_features: def.codex_disable_features,
    tmux_session_override: def.tmux_session_override,
    redis_streams: def.redis_streams,
  };
}

export function presenceFromBusAgent(agent: LegacyBase | null | undefined): AgentPresence | undefined {
  if (!agent) return undefined;
  const status = agent.status === "online" ? "online" : "offline";
  return {
    agent_id: agent.id,
    status,
    online: status === "online",
    last_heartbeat: agent.lastHeartbeat,
    address: agent.address,
    village_id: agent.village_id,
    event_subscriptions: agent.eventSubscriptions,
  };
}

export function runtimeStateFromLifecycle(agentId: string, lifecycle: Partial<AgentRuntimeState> | null | undefined): AgentRuntimeState {
  return {
    agent_id: agentId,
    status: lifecycle?.status ?? "stopped",
    pid: lifecycle?.pid,
    started_at: lifecycle?.started_at,
    tmux_session: lifecycle?.tmux_session,
    error: lifecycle?.error,
    uptime_seconds: lifecycle?.uptime_seconds,
  };
}

export function composeAgentView(input: {
  id: string;
  def: AgentDef;
  busAgent?: LegacyBase | null;
  runtimeState: AgentRuntimeState;
}): AgentView {
  const base = input.busAgent ?? { id: input.id, status: "offline" as const };
  const runtimeState = runtimeStateFromLifecycle(input.id, input.runtimeState);
  const runtimeConfig = runtimeConfigFromAgentDef(input.def);
  const activeRuntimeProfile = runtimeConfig.llm_client_profile ?? runtimeConfig.runtime;
  const fallbackRuntimeProfile = runtimeConfig.fallback_llm_client_profile ?? runtimeConfig.fallback_runtime;
  const fallbackProfile = getLLMClientProfile(runtimeConfig.fallback_llm_client_profile);
  const fallbackDisabled = fallbackProfile?.disabled === true;
  return {
    ...base,
    ...input.def,
    presence: presenceFromBusAgent(base),
    runtime_config: runtimeConfig,
    template: templateFromAgentDef(input.def),
    runtime_state: runtimeState,
    active_runtime_profile: activeRuntimeProfile,
    fallback_runtime_profile: fallbackRuntimeProfile,
    auto_runtime_fallback: Boolean(runtimeConfig.fallback_llm_client_profile && activeRuntimeProfile !== fallbackRuntimeProfile && !fallbackDisabled),
    lifecycle: {
      status: runtimeState.status,
      pid: runtimeState.pid,
      uptime_seconds: runtimeState.uptime_seconds,
    },
  };
}
