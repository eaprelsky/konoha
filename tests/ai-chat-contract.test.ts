import { afterAll, describe, expect, mock, test } from "bun:test";
import { createTestRedis } from "./redis-test-utils";
import { createWorkflow, WORKFLOW_INDEX_KEY } from "../src/workflow-loader";
import { pgDeleteWorkflow } from "../src/storage/pg";
import { createRole, deleteRole } from "../src/runtime/roles";

process.env.KONOHA_PORT = "0";
process.env.ANTHROPIC_API_KEY ||= "test-anthropic-key";

mock.module("../src/llm", () => ({
  generateText: async () => JSON.stringify({
    reply: "Готово: обновила схему.",
    schema_patch: {
      set_name: "Contract workflow updated",
    },
  }),
}));

const TEST_ADMIN_TOKEN = process.env.KONOHA_TOKEN || "test-admin-token-preload";
const { app } = await import("../core/src/server");
const redis = createTestRedis();

function adminHeaders() {
  return { Authorization: `Bearer ${TEST_ADMIN_TOKEN}`, "Content-Type": "application/json" };
}

afterAll(async () => {
  await redis.del("tsunade:chat:test-ai-chat-contract");
  await redis.del("tsunade:chat:test-ai-chat-contract-delete");
  await redis.hdel("konoha:config:autonomy", "workflow.patch");
  await redis.del("workflow:wf-contract");
  await redis.srem(WORKFLOW_INDEX_KEY, "wf-contract");
  await pgDeleteWorkflow("wf-contract").catch(() => {});
  await deleteRole("wf-contract-role").catch(() => {});
  redis.disconnect();
  delete process.env.KONOHA_PORT;
});

describe("POST /api/ai/chat workflow contract", () => {
  test("returns canonical workflow envelope for non-streaming process chat", async () => {
    await redis.hset("konoha:config:autonomy", "workflow.patch", "auto");
    await createRole({ role_id: "wf-contract-role", name: "Workflow contract role", strategy: "manual", assignees: [] });
    await createWorkflow({
      id: "wf-contract",
      version: "1.0",
      name: "Contract workflow",
      elements: [
        { id: "start", type: "event", label: "Start", trigger: { kind: "manual", manual_override: true } },
        { id: "review", type: "function", label: "Review", role: "wf-contract-role" },
        { id: "done", type: "event", label: "Done" },
      ],
      flow: [["start", "review"], ["review", "done"]],
    }, { draft: true });

    const res = await app.fetch(new Request("http://localhost/api/ai/chat", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        message: "Переименуй шаг",
        chat_id: "test-ai-chat-contract",
        mode: "process",
        schema: {
          id: "wf-contract",
          name: "Contract workflow",
          elements: [{ id: "f1", type: "function", label: "Старый шаг" }],
          flow: [],
        },
      }),
    }));

    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.reply).toContain("Готово: обновила схему.");
    expect(body.reply).toContain("workflow.patch");
    expect(body.schema_patch.set_name).toBe("Contract workflow updated");
    expect(body.action_receipts[0].action).toBe("workflow.patch");
    expect(body.observable_result.status).toBe("succeeded");
    expect(body.pending_confirmations).toEqual([]);
    await redis.hdel("konoha:config:autonomy", "workflow.patch");
  });

  test("deprecated Tsunade chat routes return 404 (legacy retirement)", async () => {
    for (const path of ["/api/tsunade/chat", "/api/ai/process-chat"]) {
      const res = await app.fetch(new Request(`http://localhost${path}`, {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({ message: "test" }),
      }));

      expect(res.status).toBe(404);
    }
  });

  test("deprecated Tsunade chat delete routes return 404 (legacy retirement)", async () => {
    for (const path of ["/api/tsunade/chat/test-legacy-delete", "/api/ai/process-chat/test-legacy-delete"]) {
      const res = await app.fetch(new Request(`http://localhost${path}`, {
        method: "DELETE",
        headers: adminHeaders(),
      }));

      expect(res.status).toBe(404);
    }
  });
});
