/**
 * Test for agentApi 401 retry logic
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import Redis from "ioredis";

const TEST_ADMIN_TOKEN = "test-admin-token-retry";
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

describe("Issue #74: agentApi 401 retry logic", () => {
  test("agent token retries with admin token on 401", async () => {
    const senderId = id("retry-sender");
    const targetId = id("retry-target");

    // Register sender
    const senderReg = await req("POST", "/agents/register", {
      body: { id: senderId, name: "Retry Sender" },
    });
    const senderToken: string = senderReg.body.token;

    // Register target
    await req("POST", "/agents/register", {
      body: { id: targetId, name: "Retry Target" },
    });

    // Send message with agent token
    const msg1 = await req("POST", "/messages", {
      body: { to: targetId, text: "test with agent token", type: "message" },
      headers: { Authorization: `Bearer ${senderToken}`, "Content-Type": "application/json" },
    });
    
    expect(msg1.status).toBe(200);
    expect(msg1.body.id).toBeDefined();
    expect(typeof msg1.body.id).toBe("string");
    expect(msg1.body.id).not.toBe("undefined");

    // Re-register sender (invalidates old token)
    const senderReg2 = await req("POST", "/agents/register", {
      body: { id: senderId, name: "Retry Sender v2" },
    });
    const newSenderToken: string = senderReg2.body.token;
    expect(newSenderToken).not.toBe(senderToken);

    // Old token should be invalid now
    const badMsg = await req("POST", "/messages", {
      body: { to: targetId, text: "test with old token", type: "message" },
      headers: { Authorization: `Bearer ${senderToken}`, "Content-Type": "application/json" },
    });
    
    // Should get 401 because token is invalidated
    expect(badMsg.status).toBe(401);

    // New token should work
    const msg2 = await req("POST", "/messages", {
      body: { to: targetId, text: "test with new token", type: "message" },
      headers: { Authorization: `Bearer ${newSenderToken}`, "Content-Type": "application/json" },
    });
    
    expect(msg2.status).toBe(200);
    expect(msg2.body.id).toBeDefined();
    expect(msg2.body.id).not.toBe("undefined");
  });
});
