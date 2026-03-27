/**
 * Issue #74: konoha_send MCP tool returns ID: undefined instead of real message ID
 * 
 * Test specifically for the bug where redis.xadd() may return null/undefined
 * and the MCP tool doesn't handle it properly.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import Redis from "ioredis";

const TEST_ADMIN_TOKEN = "test-admin-token-issue74";
process.env.KONOHA_TOKEN = TEST_ADMIN_TOKEN;
process.env.KONOHA_PORT = "0";

const { app } = await import("../src/server");
const redis = new Redis({ host: "127.0.0.1", port: 6379 });

const RUN = `t${Date.now()}`;
function id(name: string) { return `test-${name}-${RUN}`; }

async function req(
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {}
) {
  const init: RequestInit = {
    method,
    headers: opts.headers ?? { Authorization: `Bearer ${TEST_ADMIN_TOKEN}`, "Content-Type": "application/json" },
  };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
  }
  const res = await app.fetch(new Request(`http://localhost${path}`, init));
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

async function cleanup() {
  const keys = await redis.hkeys("konoha:registry");
  for (const k of keys) {
    if (k.startsWith("test-")) await redis.hdel("konoha:registry", k);
  }
  const streamKeys = await redis.keys("konoha:agent:test-*");
  if (streamKeys.length) await redis.del(...streamKeys);
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  redis.disconnect();
});

describe("Issue #74: konoha_send returns ID correctly", () => {
  test("POST /messages always returns a valid string ID", async () => {
    const to = id("issue74-target");
    await req("POST", "/agents/register", { body: { id: to, name: "Issue74 Target" } });

    const { status, body } = await req("POST", "/messages", {
      body: { from: id("sender"), to, text: "test message for issue 74", type: "message" },
    });

    console.log("Response status:", status);
    console.log("Response body:", body);

    expect(status).toBe(200);
    expect(body).toBeDefined();
    expect(body.id).toBeDefined();
    expect(typeof body.id).toBe("string");
    expect(body.id).not.toBe("undefined");
    expect(body.id.length).toBeGreaterThan(0);
  });

  test("konoha_send MCP tool returns 'Sent. ID: <valid_id>'", async () => {
    // This test emulates what the MCP tool receives
    const to = id("issue74-mcp");
    await req("POST", "/agents/register", { body: { id: to, name: "Issue74 MCP" } });

    const { status, body } = await req("POST", "/messages", {
      body: { 
        from: id("mcp-sender"), 
        to, 
        text: "test for MCP tool parsing",
        type: "message",
        channel: "test-channel"
      },
    });

    expect(status).toBe(200);
    expect(body.id).toBeDefined();
    expect(typeof body.id).toBe("string");
    
    // Simulate what MCP tool does:
    const responseText = `Sent. ID: ${body.id}`;
    expect(responseText).not.toContain("undefined");
    expect(responseText).toMatch(/^Sent\. ID: .+$/);
    expect(responseText).not.toMatch(/undefined/);
  });

  test("redis.xadd returns consistent IDs across multiple sends", async () => {
    const to = id("issue74-multiple");
    await req("POST", "/agents/register", { body: { id: to, name: "Issue74 Multiple" } });

    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { body } = await req("POST", "/messages", {
        body: { from: id("multi-sender"), to, text: `message ${i}`, type: "message" },
      });
      expect(body.id).toBeDefined();
      ids.push(body.id);
    }

    // All IDs should be different
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(5);

    // All should be valid Redis stream IDs (timestamp-sequence format)
    for (const id of ids) {
      expect(typeof id).toBe("string");
      expect(id).toContain("-");
      expect(id).not.toBe("undefined");
    }
  });
});
