import { describe, expect, test } from "bun:test";
import { listLLMClientProfiles, resolveAgentRuntime, resolveLLMClientProfile } from "../src/agent";

describe("LLM client profiles", () => {
  test("resolves Kakashi DeepSeek profile through Claude adapter", () => {
    const runtime = resolveAgentRuntime({
      model: "claude:opus",
      runtime: "claude",
      llm_client_profile: "claude-deepseek-opus",
    });

    expect(runtime.provider).toBe("claude");
    expect(runtime.runtimeModel).toBe("opus");
    expect(resolveLLMClientProfile({
      model: "claude:opus",
      runtime: "claude",
      llm_client_profile: "claude-deepseek-opus",
    })?.model).toBe("deepseek-v4-pro");
  });

  test("maps GLM profile to the existing GLM launch path", () => {
    const runtime = resolveAgentRuntime({
      model: "glm:glm-5.1",
      runtime: "glm",
      llm_client_profile: "claude-glm-sonnet",
    });

    expect(runtime.provider).toBe("glm");
    expect(runtime.runtimeModel).toBe("sonnet");
  });

  test("keeps legacy runtime/model resolution working", () => {
    const runtime = resolveAgentRuntime({ model: "claude:haiku", runtime: "claude" });

    expect(runtime.provider).toBe("claude");
    expect(runtime.runtimeModel).toBe("haiku");
    expect(resolveLLMClientProfile({ model: "claude:haiku", runtime: "claude" })?.id).toBe("claude-deepseek-haiku");
  });

  test("does not rewrite legacy Codex definitions to a different model", () => {
    const runtime = resolveAgentRuntime({ model: "codex:gpt-5.4", runtime: "codex" });

    expect(runtime.provider).toBe("codex");
    expect(runtime.runtimeModel).toBe("gpt-5.4");
    expect(resolveLLMClientProfile({ model: "codex:gpt-5.4", runtime: "codex" })).toBeUndefined();
  });

  test("fails fast on unknown explicit profiles", () => {
    expect(() => resolveAgentRuntime({
      model: "claude:sonnet",
      runtime: "claude",
      llm_client_profile: "missing-profile",
    })).toThrow("Unknown LLM client profile: missing-profile");
  });

  test("contains enabled Codex fallback profile", () => {
    const profile = listLLMClientProfiles().find((item) => item.id === "codex-gpt-5.5");

    expect(profile?.runtime_adapter).toBe("codex");
    expect(profile?.disabled).not.toBe(true);
  });
});
