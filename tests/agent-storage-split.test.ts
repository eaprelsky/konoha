import { afterAll, describe, expect, test } from "bun:test";
import { createTestRedis } from "./redis-test-utils";
import {
  createAgentDef,
  deleteAgentDef,
  getAgentDef,
  listAgentDefs,
  updateAgentDef,
} from "../src/agent";
import type { AgentDef } from "../src/agent";

const redis = createTestRedis();
const RUN = `t${Date.now()}`;
const agentId = `test-agent-storage-${RUN}`;

function baseInput(): Omit<AgentDef, "created_at" | "updated_at"> {
  return {
    id: agentId,
    name: "Storage Split Test",
    display_alias: "Instance Alias",
    runtime: "claude",
    llm_client_profile: "claude-deepseek-sonnet",
    model: "claude:sonnet",
    capabilities: ["test"],
    tags: ["test"],
  };
}

async function cleanup() {
  await redis.hdel("konoha:agent-defs", agentId);
  await redis.hdel("konoha:agent-templates", agentId);
  await redis.hdel("konoha:agent-runtime-configs", agentId);
  await redis.hdel("konoha:agent-states", agentId);
}

afterAll(async () => {
  await cleanup();
  redis.disconnect();
});

describe("agent definition split storage", () => {
  test("dual-writes legacy def, template, and runtime config", async () => {
    await cleanup();

    const def = await createAgentDef(baseInput());
    const [legacyRaw, templateRaw, runtimeConfigRaw] = await Promise.all([
      redis.hget("konoha:agent-defs", agentId),
      redis.hget("konoha:agent-templates", agentId),
      redis.hget("konoha:agent-runtime-configs", agentId),
    ]);

    expect(JSON.parse(legacyRaw ?? "{}").id).toBe(def.id);
    expect(JSON.parse(templateRaw ?? "{}")).toMatchObject({ id: agentId, name: "Storage Split Test", display_alias: "Instance Alias", tags: ["test"] });
    expect(JSON.parse(runtimeConfigRaw ?? "{}")).toMatchObject({ model: "claude:sonnet", llm_client_profile: "claude-deepseek-sonnet" });
  });

  test("can read from split storage when legacy def is absent", async () => {
    await redis.hdel("konoha:agent-defs", agentId);

    const def = await getAgentDef(agentId);

    expect(def?.id).toBe(agentId);
    expect(def?.name).toBe("Storage Split Test");
    expect(def?.model).toBe("claude:sonnet");
  });

  test("updates and lists through split-aware helpers", async () => {
    const updated = await updateAgentDef(agentId, { name: "Storage Split Updated", display_alias: "Updated Callsign", model: "claude:opus" });
    const listed = await listAgentDefs();
    const found = listed.find((item) => item.id === agentId);

    expect(updated?.name).toBe("Storage Split Updated");
    expect(found?.display_alias).toBe("Updated Callsign");
    expect(found?.model).toBe("claude:opus");
    expect(JSON.parse((await redis.hget("konoha:agent-runtime-configs", agentId)) ?? "{}").model).toBe("claude:opus");
  });

  test("deletes all storage projections", async () => {
    await deleteAgentDef(agentId);

    expect(await getAgentDef(agentId)).toBeNull();
    expect(await redis.hget("konoha:agent-defs", agentId)).toBeNull();
    expect(await redis.hget("konoha:agent-templates", agentId)).toBeNull();
    expect(await redis.hget("konoha:agent-runtime-configs", agentId)).toBeNull();
  });
});
