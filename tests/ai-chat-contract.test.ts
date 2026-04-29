import { afterAll, describe, expect, mock, test } from "bun:test";
import Redis from "ioredis";

process.env.KONOHA_PORT = "0";
process.env.ANTHROPIC_API_KEY ||= "test-anthropic-key";

mock.module("../src/llm", () => ({
  generateText: async () => JSON.stringify({
    reply: "Готово: обновила схему.",
    schema_patch: {
      update_elements: [{ id: "f1", label: "Согласовать заявку" }],
    },
  }),
}));

const TEST_ADMIN_TOKEN = process.env.KONOHA_TOKEN || "test-admin-token-preload";
const { app } = await import("../core/src/server");
const redis = new Redis({ host: "127.0.0.1", port: 6379, db: parseInt(process.env.REDIS_DB ?? "0") });

function adminHeaders() {
  return { Authorization: `Bearer ${TEST_ADMIN_TOKEN}`, "Content-Type": "application/json" };
}

afterAll(async () => {
  await redis.del("tsunade:chat:test-ai-chat-contract");
  redis.disconnect();
  delete process.env.KONOHA_PORT;
});

describe("POST /api/ai/chat workflow contract", () => {
  test("returns canonical workflow envelope for non-streaming process chat", async () => {
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
    expect(body.reply).toBe("Готово: обновила схему.");
    expect(body.schema_patch.update_elements[0].id).toBe("f1");
    expect(body.action_receipts[0].action).toBe("workflow.update");
    expect(body.observable_result.status).toBe("succeeded");
    expect(body.pending_confirmations).toEqual([]);
  });

  test("deprecated Tsunade chat routes advertise canonical replacement", async () => {
    for (const path of ["/api/tsunade/chat", "/api/ai/process-chat"]) {
      const res = await app.fetch(new Request(`http://localhost${path}`, {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({
          message: "Покажи процесс",
          chat_id: `test-ai-chat-contract-deprecated-${path.replace(/\W+/g, "-")}`,
        }),
      }));

      expect(res.status).toBe(200);
      expect(res.headers.get("Deprecation")).toBe("true");
      expect(res.headers.get("Sunset")).toBe("Sat, 31 May 2026 00:00:00 GMT");
      expect(res.headers.get("Link")).toBe('</api/ai/chat?mode=process>; rel="canonical"');
    }
  });
});
