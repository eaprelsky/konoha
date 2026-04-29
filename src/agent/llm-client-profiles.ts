import type { AgentDef, AgentProvider } from "./types";

export type RuntimeAdapter = "claude" | "codex" | "cursor" | "opencode";
export type ProviderKind =
  | "anthropic"
  | "anthropic-compatible"
  | "openai"
  | "openai-compatible"
  | "chatgpt-codex"
  | "local";

export interface LLMClientProfile {
  id: string;
  runtime_adapter: RuntimeAdapter;
  provider_kind: ProviderKind;
  provider_profile?: string;
  model: string;
  runtime_model?: string;
  reasoning_effort?: string;
  capabilities: string[];
  disabled?: boolean;
  disabled_reason?: string;
}

const PROFILES: Record<string, LLMClientProfile> = {
  "claude-deepseek-haiku": {
    id: "claude-deepseek-haiku",
    runtime_adapter: "claude",
    provider_kind: "anthropic-compatible",
    provider_profile: "deepseek",
    model: "deepseek-v4-flash",
    runtime_model: "haiku",
    capabilities: ["text", "cheap_classifier"],
  },
  "claude-deepseek-sonnet": {
    id: "claude-deepseek-sonnet",
    runtime_adapter: "claude",
    provider_kind: "anthropic-compatible",
    provider_profile: "deepseek",
    model: "deepseek-v4-pro",
    runtime_model: "sonnet",
    capabilities: ["text", "tool_use", "code", "long_context", "reasoning"],
  },
  "claude-deepseek-opus": {
    id: "claude-deepseek-opus",
    runtime_adapter: "claude",
    provider_kind: "anthropic-compatible",
    provider_profile: "deepseek",
    model: "deepseek-v4-pro",
    runtime_model: "opus",
    capabilities: ["text", "tool_use", "code", "long_context", "reasoning"],
  },
  "claude-glm-sonnet": {
    id: "claude-glm-sonnet",
    runtime_adapter: "claude",
    provider_kind: "anthropic-compatible",
    provider_profile: "glm",
    model: "glm-5.1",
    runtime_model: "sonnet",
    capabilities: ["text", "tool_use", "code", "long_context", "reasoning"],
  },
  "claude-glm-haiku": {
    id: "claude-glm-haiku",
    runtime_adapter: "claude",
    provider_kind: "anthropic-compatible",
    provider_profile: "glm",
    model: "glm-4.5-air",
    runtime_model: "haiku",
    capabilities: ["text", "cheap_classifier"],
  },
  "codex-gpt-5.5": {
    id: "codex-gpt-5.5",
    runtime_adapter: "codex",
    provider_kind: "chatgpt-codex",
    model: "gpt-5.5",
    runtime_model: "gpt-5.5",
    reasoning_effort: "high",
    capabilities: ["text", "tool_use", "code", "long_context", "reasoning"],
    disabled: true,
    disabled_reason: "Codex CLI upgraded to 0.125.0 (#574). Blocked until proxy/VPN upstream credentials are refreshed (#565).",
  },
};

export function listLLMClientProfiles(): LLMClientProfile[] {
  return Object.values(PROFILES).sort((a, b) => a.id.localeCompare(b.id));
}

export function getLLMClientProfile(id: string | undefined): LLMClientProfile | undefined {
  return id ? PROFILES[id] : undefined;
}

function legacyProfileId(def: Pick<AgentDef, "model" | "runtime">): string | undefined {
  const runtime = def.runtime;
  const model = (def.model || "").trim();
  if (runtime === "glm" || model.startsWith("glm:")) return model.includes("haiku") || model.includes("4.5-air") ? "claude-glm-haiku" : "claude-glm-sonnet";
  if (runtime === "claude" || model.startsWith("claude:")) {
    if (model.includes("haiku")) return "claude-deepseek-haiku";
    if (model.includes("opus")) return "claude-deepseek-opus";
    return "claude-deepseek-sonnet";
  }
  return undefined;
}

export function resolveLLMClientProfile(def: Pick<AgentDef, "llm_client_profile" | "model" | "runtime">): LLMClientProfile | undefined {
  if (def.llm_client_profile) return getLLMClientProfile(def.llm_client_profile);
  return getLLMClientProfile(legacyProfileId(def));
}

export function profileAgentProvider(profile: LLMClientProfile): AgentProvider | undefined {
  if (profile.runtime_adapter === "codex" || profile.runtime_adapter === "cursor") return profile.runtime_adapter;
  if (profile.runtime_adapter === "claude") return profile.provider_profile === "glm" ? "glm" : "claude";
  return undefined;
}
