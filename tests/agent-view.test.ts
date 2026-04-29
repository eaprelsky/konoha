import { describe, expect, test } from "bun:test";
import { composeAgentView, presenceFromBusAgent, runtimeConfigFromAgentDef, templateFromAgentDef } from "../src/agent";
import type { AgentDef, AgentState } from "../src/agent";

const def: AgentDef = {
  id: "sasuke",
  name: "Sasuke",
  runtime: "claude",
  fallback_runtime: "codex",
  llm_client_profile: "claude-deepseek-sonnet",
  fallback_llm_client_profile: "codex-gpt-5.5",
  launch_strategy: "persistent_interactive",
  startup_timeout_sec: 180,
  model: "claude:sonnet",
  capabilities: ["telegram"],
  tool_profile: "telegram-userbot",
  sandbox_profile: "tmux",
  tags: ["system"],
  shared_mcp_allowlist: ["yonote"],
  redis_streams: [{ stream: "telegram:incoming", group: "sasuke" }],
  protected: true,
  created_at: "2026-04-29T00:00:00.000Z",
  updated_at: "2026-04-29T00:00:00.000Z",
};

const runtimeState: AgentState = {
  agent_id: "sasuke",
  status: "running",
  pid: 123,
  uptime_seconds: 45,
};

describe("agent view boundaries", () => {
  test("splits template fields from runtime config fields", () => {
    expect(templateFromAgentDef(def)).toEqual({
      id: "sasuke",
      name: "Sasuke",
      system_prompt: undefined,
      tool_profile: "telegram-userbot",
      sandbox_profile: "tmux",
      tags: ["system"],
      capabilities: ["telegram"],
      memory: undefined,
      avatar_url: undefined,
      gender: undefined,
      protected: true,
      created_at: "2026-04-29T00:00:00.000Z",
      updated_at: "2026-04-29T00:00:00.000Z",
    });

    expect(runtimeConfigFromAgentDef(def)).toMatchObject({
      runtime: "claude",
      fallback_runtime: "codex",
      llm_client_profile: "claude-deepseek-sonnet",
      fallback_llm_client_profile: "codex-gpt-5.5",
      model: "claude:sonnet",
      shared_mcp_allowlist: ["yonote"],
    });
  });

  test("maps bus heartbeat data to explicit presence", () => {
    const presence = presenceFromBusAgent({
      id: "sasuke",
      name: "Sasuke",
      status: "online",
      lastHeartbeat: 12345,
      address: "sasuke@default",
      village_id: "default",
      capabilities: [],
      roles: [],
    });

    expect(presence).toEqual({
      agent_id: "sasuke",
      status: "online",
      online: true,
      last_heartbeat: 12345,
      address: "sasuke@default",
      village_id: "default",
      event_subscriptions: undefined,
    });
  });

  test("keeps legacy flattened API fields while adding structured boundaries", () => {
    const view = composeAgentView({
      id: "sasuke",
      def,
      busAgent: { id: "sasuke", status: "online", lastHeartbeat: 12345 },
      runtimeState,
    });

    expect(view.id).toBe("sasuke");
    expect(view.model).toBe("claude:sonnet");
    expect(view.status).toBe("online");
    expect(view.lifecycle.status).toBe("running");
    expect(view.presence?.online).toBe(true);
    expect(view.runtime_state.pid).toBe(123);
    expect(view.runtime_config.llm_client_profile).toBe("claude-deepseek-sonnet");
    expect(view.template.protected).toBe(true);
    expect(view.active_runtime_profile).toBe("claude-deepseek-sonnet");
    expect(view.fallback_runtime_profile).toBe("codex-gpt-5.5");
    expect(view.auto_runtime_fallback).toBe(false);
  });
});
