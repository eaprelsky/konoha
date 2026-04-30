import { afterAll, describe, expect, test } from "bun:test";
import {
  deleteAgentDef,
  getAgentDef,
  upsertAgentDef,
  type AgentDef,
} from "../src/agent";

const RUN = `t${Date.now()}`;
const agentId = `test-seed-merge-${RUN}`;

function seedInput(overrides: Partial<Omit<AgentDef, "created_at" | "updated_at">> = {}): Omit<AgentDef, "created_at" | "updated_at"> {
  return {
    id: agentId,
    name: "Seeded product name",
    display_alias: "Seeded alias",
    avatar_url: "/avatars/seeded.png",
    runtime: "claude",
    fallback_runtime: "codex",
    llm_client_profile: "claude-deepseek-sonnet",
    fallback_llm_client_profile: "codex-gpt-5.5",
    model: "claude:sonnet",
    seed_classification: "connector_owned",
    lifecycle_mode: "connector_owned",
    tags: ["system", "connector-owned"],
    capabilities: ["seeded"],
    ...overrides,
  };
}

afterAll(async () => {
  await deleteAgentDef(agentId);
});

describe("seeded agent merge policy", () => {
  test("preserves org-owned display fields while updating structural seed metadata", async () => {
    await deleteAgentDef(agentId);
    const initial = await upsertAgentDef(seedInput({
      name: "Org local product name",
      display_alias: "Org callsign",
      avatar_url: "/avatars/org.png",
      seed_classification: undefined,
      lifecycle_mode: undefined,
      tags: ["custom"],
      model: "claude:haiku",
    }));

    const reseed = await upsertAgentDef(seedInput({
      name: "New seed product name",
      display_alias: "New seed alias",
      avatar_url: "/avatars/new-seed.png",
      seed_classification: "optional_worker",
      lifecycle_mode: "optional_on_demand",
      tags: ["system", "optional-worker"],
      model: "claude:opus",
    }), {
      preserveOrgDisplayFields: true,
    });
    const stored = await getAgentDef(agentId);

    expect(initial.created).toBe(true);
    expect(reseed.created).toBe(false);
    expect(stored).toMatchObject({
      id: agentId,
      name: "Org local product name",
      display_alias: "Org callsign",
      avatar_url: "/avatars/org.png",
      seed_classification: "optional_worker",
      lifecycle_mode: "optional_on_demand",
      tags: ["system", "optional-worker"],
      model: "claude:opus",
    });
  });
});
