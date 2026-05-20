import { afterAll, describe, expect, test } from "bun:test";
import { createTestRedis } from "./redis-test-utils";
import { buildRoleBlocks, renderSystemTemplate } from "../src/agent/prompt";

const redis = createTestRedis();
const RUN = `t${Date.now()}`;
const staleRoleId = `prompt-stale-role-${RUN}`;
const activeRoleId = `prompt-active-role-${RUN}`;
const workflowId = `prompt-role-workflow-${RUN}`;

async function cleanup() {
  await redis
    .multi()
    .del(`role:${staleRoleId}`)
    .del(`role:${activeRoleId}`)
    .del(`konoha:role:${staleRoleId}:workflows`)
    .del(`konoha:role:${activeRoleId}:workflows`)
    .del(`workflow:${workflowId}`)
    .zrem("konoha:roles:all", staleRoleId, activeRoleId)
    .exec();
}

afterAll(async () => {
  await cleanup();
  redis.disconnect();
});

describe("agent prompt identity", () => {
  test("renders canonical name and mutable display alias separately", () => {
    const template = renderSystemTemplate({
      id: "sasuke",
      name: "Юзер-агент",
      display_alias: "Саске",
      runtime: "claude",
      model: "claude:sonnet",
    });

    expect(template).toContain("- Agent ID: sasuke");
    expect(template).toContain("- Agent Name: Юзер-агент");
    expect(template).toContain("- Agent Display Alias: Саске");
    expect(template).toContain("konoha_register(id=sasuke, name=Юзер-агент, display_alias=Саске");
  });

  test("falls back to canonical name when display alias is absent", () => {
    const template = renderSystemTemplate({
      id: "advisor",
      name: "Советник",
      model: "claude:sonnet",
    });

    expect(template).toContain("- Agent Display Alias: Советник");
    expect(template).toContain("display_alias=Советник");
  });

  test("skips stale role workflow indexes with no matching functions", async () => {
    await cleanup();
    const now = new Date().toISOString();
    await redis
      .multi()
      .set(`role:${staleRoleId}`, JSON.stringify({
        role_id: staleRoleId,
        name: "Stale Role",
        assignees: ["agent-under-test"],
        strategy: "manual",
        created_at: now,
        updated_at: now,
      }))
      .set(`role:${activeRoleId}`, JSON.stringify({
        role_id: activeRoleId,
        name: "Active Role",
        assignees: ["agent-under-test"],
        strategy: "manual",
        created_at: now,
        updated_at: now,
      }))
      .zadd("konoha:roles:all", Date.now(), staleRoleId, Date.now() + 1, activeRoleId)
      .sadd(`konoha:role:${staleRoleId}:workflows`, workflowId)
      .sadd(`konoha:role:${activeRoleId}:workflows`, workflowId)
      .set(`workflow:${workflowId}`, JSON.stringify({
        id: workflowId,
        version: "1.0.0",
        name: "Prompt Role Workflow",
        elements: [
          { id: "e1", type: "event", label: "Started" },
          { id: "f1", type: "function", label: "Do active work", role: activeRoleId },
          { id: "e2", type: "event", label: "Done" },
        ],
        flow: [["e1", "f1"], ["f1", "e2"]],
      }))
      .exec();

    const blocks = await buildRoleBlocks("agent-under-test");

    expect(blocks).toContain("## Role: Active Role");
    expect(blocks).toContain("#### Do active work");
    expect(blocks).not.toContain("## Role: Stale Role");
  });
});
