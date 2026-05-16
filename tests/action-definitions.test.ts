import { describe, expect, test } from "bun:test";
import { getAction, validateActionArgs } from "../src/action-registry";

describe("action definitions", () => {
  test("agent.update_profile exposes active and fallback LLM client profile fields", () => {
    const action = getAction("agent.update_profile");
    expect(action).toBeDefined();
    const argNames = new Set(action!.args.map(arg => arg.name));

    expect(argNames.has("llm_client_profile")).toBe(true);
    expect(argNames.has("fallback_llm_client_profile")).toBe(true);
    expect(validateActionArgs("agent.update_profile", {
      id: "kakashi",
      llm_client_profile: "codex-gpt-5.5",
      fallback_llm_client_profile: "claude-deepseek-sonnet",
    })).toEqual({ valid: true, errors: [] });
  });
});
