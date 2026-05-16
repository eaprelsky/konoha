import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
  AGENT_WORKDIR_ROOT,
  buildSystemPrompt,
  checkAgentPromptMirrorDrift,
  createAgentDef,
  deleteAgentDef,
  recordRenderedPromptMirror,
  updateAgentDef,
  type AgentDef,
} from "../src/agent";

const RUN = `t${Date.now()}`;
const agentId = `test-prompt-authority-${RUN}`;
const workdir = join(AGENT_WORKDIR_ROOT, agentId);
const mirrorPath = join(workdir, "AGENTS.md");

function input(overrides: Partial<Omit<AgentDef, "created_at" | "updated_at">> = {}): Omit<AgentDef, "created_at" | "updated_at"> {
  return {
    id: agentId,
    name: "Prompt Authority Test",
    runtime: "codex",
    model: "codex:gpt-5.5",
    system_prompt: "Initial DB prompt",
    ...overrides,
  };
}

afterAll(async () => {
  await deleteAgentDef(agentId);
  rmSync(workdir, { recursive: true, force: true });
});

describe("AgentDef prompt authority", () => {
  test("stores system_prompt hashes and update provenance in AgentDef projections", async () => {
    await deleteAgentDef(agentId);
    const created = await createAgentDef(input());
    const updated = await updateAgentDef(agentId, { system_prompt: "Updated DB prompt" });

    expect(typeof created.system_prompt_hash).toBe("string");
    expect(created.system_prompt_updated_by).toBe("agent.create");
    expect(typeof updated?.system_prompt_hash).toBe("string");
    expect(updated?.system_prompt_hash).not.toBe(created.system_prompt_hash);
    expect(updated?.system_prompt_updated_by).toBe("agent.update_profile");
    expect(updated?.system_prompt_updated_at).not.toBe(created.system_prompt_updated_at);
  });

  test("records generated AGENTS.md mirror hashes and reports drift against AgentDef.system_prompt", async () => {
    const def = await updateAgentDef(agentId, { system_prompt: "Mirror source prompt" });
    expect(def).not.toBeNull();

    mkdirSync(workdir, { recursive: true });
    const expected = await buildSystemPrompt(agentId, def!);
    writeFileSync(mirrorPath, expected, "utf-8");
    await recordRenderedPromptMirror(agentId, expected, mirrorPath);

    const ok = await checkAgentPromptMirrorDrift(agentId);
    expect(ok.status).toBe("ok");
    expect(ok.source).toBe("AgentDef.system_prompt");
    expect(ok.expected_hash).toBe(ok.mirror_hash);

    writeFileSync(mirrorPath, `${expected}\nlocal edit`, "utf-8");
    const drift = await checkAgentPromptMirrorDrift(agentId);
    expect(drift.status).toBe("drift");
    expect(drift.expected_hash).not.toBe(drift.mirror_hash);
  });
});
