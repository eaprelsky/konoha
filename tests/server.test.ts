/**
 * Konoha server unit tests — bun test
 *
 * Tests run against the real Hono app (app.fetch) + real Redis.
 * Test-specific agent IDs are prefixed with "test-" and cleaned up in afterAll.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import Redis from "ioredis";

// Set env before importing server so ADMIN_TOKEN is predictable
const TEST_ADMIN_TOKEN = "test-admin-token-kakashi";
process.env.KONOHA_TOKEN = TEST_ADMIN_TOKEN;
process.env.KONOHA_PORT = "0"; // don't actually bind a port

const { app } = await import("../src/server");

// ── helpers ───────────────────────────────────────────────────────────────────

const redis = new Redis({ host: "127.0.0.1", port: 6379 });

function adminHeaders(extra: Record<string, string> = {}) {
  return { Authorization: `Bearer ${TEST_ADMIN_TOKEN}`, "Content-Type": "application/json", ...extra };
}

async function req(
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {}
) {
  const init: RequestInit = {
    method,
    headers: opts.headers ?? adminHeaders(),
  };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
  }
  const res = await app.fetch(new Request(`http://localhost${path}`, init));
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

// Unique suffix per test run to avoid collisions with production data
const RUN = `t${Date.now()}`;
function id(name: string) { return `test-${name}-${RUN}`; }

// ── cleanup ───────────────────────────────────────────────────────────────────

async function cleanupTestAgents() {
  const keys = await redis.hkeys("konoha:registry");
  for (const k of keys) {
    if (k.startsWith("test-")) await redis.hdel("konoha:registry", k);
  }
  // clean per-agent streams
  const streamKeys = await redis.keys("konoha:agent:test-*");
  if (streamKeys.length) await redis.del(...streamKeys);
  // clean token entries
  const tokenMap = await redis.hgetall("konoha:tokens");
  for (const [tok, agentId] of Object.entries(tokenMap ?? {})) {
    if (agentId.startsWith("test-")) await redis.hdel("konoha:tokens", tok);
  }
}

beforeAll(cleanupTestAgents);
afterAll(async () => {
  await cleanupTestAgents();
  redis.disconnect();
});

// ── /health ───────────────────────────────────────────────────────────────────

describe("GET /health", () => {
  test("returns ok without auth", async () => {
    const res = await app.fetch(new Request("http://localhost/health"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(typeof body.ts).toBe("string");
  });
});

// ── /agents/register ─────────────────────────────────────────────────────────

describe("POST /agents/register", () => {
  test("registers agent with admin token", async () => {
    const { status, body } = await req("POST", "/agents/register", {
      body: { id: id("reg1"), name: "Test Agent Reg1", capabilities: ["test"], roles: ["qa"] },
    });
    expect(status).toBe(201);
    expect(body.id).toBe(id("reg1"));
    expect(body.status).toBe("online");
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(8);
  });

  test("returns 400 when id or name missing", async () => {
    const { status, body } = await req("POST", "/agents/register", {
      body: { name: "No ID Agent" },
    });
    expect(status).toBe(400);
    expect(body.error).toContain("required");
  });

  test("returns 401 without token", async () => {
    const { status } = await req("POST", "/agents/register", {
      body: { id: id("noauth"), name: "Noauth" },
      headers: { "Content-Type": "application/json" },
    });
    expect(status).toBe(401);
  });

  test("registers with valid invite token", async () => {
    // Create invite
    const inv = await req("POST", "/agents/invite", { body: {} });
    expect(inv.status).toBe(201);
    const inviteToken: string = inv.body.token;
    expect(inviteToken.startsWith("inv-")).toBe(true);

    // Register with invite
    const { status, body } = await req("POST", "/agents/register", {
      body: { id: id("invited"), name: "Invited Agent" },
      headers: { Authorization: `Bearer ${inviteToken}`, "Content-Type": "application/json" },
    });
    expect(status).toBe(201);
    expect(body.id).toBe(id("invited"));
  });

  test("invite token is consumed (one-time use)", async () => {
    const inv = await req("POST", "/agents/invite", { body: {} });
    const inviteToken: string = inv.body.token;

    // First use — OK
    await req("POST", "/agents/register", {
      body: { id: id("inv2a"), name: "Inv 2a" },
      headers: { Authorization: `Bearer ${inviteToken}`, "Content-Type": "application/json" },
    });

    // Second use — should fail
    const { status } = await req("POST", "/agents/register", {
      body: { id: id("inv2b"), name: "Inv 2b" },
      headers: { Authorization: `Bearer ${inviteToken}`, "Content-Type": "application/json" },
    });
    expect(status).toBe(401);
  });

  test("re-registering same agent replaces token", async () => {
    const agentId = id("rereg");
    const first = await req("POST", "/agents/register", {
      body: { id: agentId, name: "Re-reg Agent" },
    });
    const firstToken: string = first.body.token;

    const second = await req("POST", "/agents/register", {
      body: { id: agentId, name: "Re-reg Agent v2" },
    });
    const secondToken: string = second.body.token;

    expect(firstToken).not.toBe(secondToken);

    // Old token should be invalid
    const { status } = await req("GET", `/messages/${agentId}`, {
      headers: { Authorization: `Bearer ${firstToken}`, "Content-Type": "application/json" },
    });
    expect(status).toBe(401);
  });
});

// ── GET /agents ───────────────────────────────────────────────────────────────

describe("GET /agents", () => {
  test("returns array", async () => {
    const { status, body } = await req("GET", "/agents");
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
  });

  test("returns 401 without auth", async () => {
    const { status } = await req("GET", "/agents", {
      headers: { "Content-Type": "application/json" },
    });
    expect(status).toBe(401);
  });

  test("includes newly registered agent", async () => {
    const agentId = id("listed");
    await req("POST", "/agents/register", {
      body: { id: agentId, name: "Listed Agent", roles: ["test-role"] },
    });
    const { body } = await req("GET", "/agents");
    const found = body.find((a: any) => a.id === agentId);
    expect(found).toBeDefined();
    expect(found.name).toBe("Listed Agent");
    expect(found.roles).toContain("test-role");
  });
});

// ── Heartbeat ─────────────────────────────────────────────────────────────────

describe("POST /agents/:id/heartbeat", () => {
  test("admin can send heartbeat for any agent", async () => {
    const agentId = id("hb-admin");
    await req("POST", "/agents/register", { body: { id: agentId, name: "HB Admin" } });

    const { status, body } = await req("POST", `/agents/${agentId}/heartbeat`, { body: {} });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });

  test("agent token can send heartbeat for itself", async () => {
    const agentId = id("hb-self");
    const reg = await req("POST", "/agents/register", { body: { id: agentId, name: "HB Self" } });
    const agentToken: string = reg.body.token;

    const { status, body } = await req("POST", `/agents/${agentId}/heartbeat`, {
      body: {},
      headers: { Authorization: `Bearer ${agentToken}`, "Content-Type": "application/json" },
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });

  test("agent token cannot send heartbeat for another agent", async () => {
    const agentId1 = id("hb-a");
    const agentId2 = id("hb-b");
    await req("POST", "/agents/register", { body: { id: agentId1, name: "HB A" } });
    const reg2 = await req("POST", "/agents/register", { body: { id: agentId2, name: "HB B" } });
    const token2: string = reg2.body.token;

    // agent2 tries to send heartbeat for agent1
    const { status } = await req("POST", `/agents/${agentId1}/heartbeat`, {
      body: {},
      headers: { Authorization: `Bearer ${token2}`, "Content-Type": "application/json" },
    });
    expect(status).toBe(403);
  });

  test("heartbeat updates lastHeartbeat in registry", async () => {
    const agentId = id("hb-ts");
    await req("POST", "/agents/register", { body: { id: agentId, name: "HB TS" } });

    const before = Date.now();
    await req("POST", `/agents/${agentId}/heartbeat`, { body: {} });
    const after = Date.now();

    const raw = await redis.hget("konoha:registry", agentId);
    const stored = JSON.parse(raw!);
    expect(stored.lastHeartbeat).toBeGreaterThanOrEqual(before);
    expect(stored.lastHeartbeat).toBeLessThanOrEqual(after + 100);
    expect(stored.status).toBe("online");
  });
});

// ── POST /messages ────────────────────────────────────────────────────────────

describe("POST /messages", () => {
  test("sends message with admin token", async () => {
    const to = id("msg-to");
    await req("POST", "/agents/register", { body: { id: to, name: "Msg Target" } });

    const { status, body } = await req("POST", "/messages", {
      body: { from: id("msg-sender"), to, text: "hello", type: "message" },
    });
    expect(status).toBe(200);
    expect(typeof body.id).toBe("string");
    expect(body.id.length).toBeGreaterThan(0);
  });

  test("returns 400 when required fields missing", async () => {
    const { status, body } = await req("POST", "/messages", {
      body: { from: "x", text: "no target" },
    });
    expect(status).toBe(400);
    expect(body.error).toBeDefined();
  });

  test("returns 401 without auth", async () => {
    const { status } = await req("POST", "/messages", {
      body: { from: "x", to: "y", text: "test" },
      headers: { "Content-Type": "application/json" },
    });
    expect(status).toBe(401);
  });

  test("agent token sends message as itself (from is auto-set)", async () => {
    const senderId = id("msg-self");
    const targetId = id("msg-target-self");
    const senderReg = await req("POST", "/agents/register", { body: { id: senderId, name: "Sender" } });
    await req("POST", "/agents/register", { body: { id: targetId, name: "Target" } });
    const senderToken: string = senderReg.body.token;

    const { status } = await req("POST", "/messages", {
      body: { to: targetId, text: "from agent token", type: "message" },
      headers: { Authorization: `Bearer ${senderToken}`, "Content-Type": "application/json" },
    });
    expect(status).toBe(200);

    // Verify message arrived with correct from
    const msgs = await req("GET", `/messages/${targetId}`);
    const found = msgs.body.find((m: any) => m.text === "from agent token");
    expect(found).toBeDefined();
    expect(found.from).toBe(senderId);
  });
});

// ── GET /messages/:agentId ────────────────────────────────────────────────────

describe("GET /messages/:agentId", () => {
  test("reads messages for agent with admin token", async () => {
    const agentId = id("read-agent");
    await req("POST", "/agents/register", { body: { id: agentId, name: "Read Agent" } });
    await req("POST", "/messages", {
      body: { from: "tester", to: agentId, text: "test message", type: "message" },
    });

    const { status, body } = await req("GET", `/messages/${agentId}`);
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    const found = body.find((m: any) => m.text === "test message");
    expect(found).toBeDefined();
    expect(found.from).toBe("tester");
    expect(found.to).toBe(agentId);
  });

  test("non-existent agent returns empty array (not 404)", async () => {
    const { status, body } = await req("GET", `/messages/${id("ghost-agent")}`);
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  test("agent token can read own inbox", async () => {
    const agentId = id("own-inbox");
    const reg = await req("POST", "/agents/register", { body: { id: agentId, name: "Own Inbox" } });
    const token: string = reg.body.token;

    await req("POST", "/messages", {
      body: { from: "anyone", to: agentId, text: "private msg", type: "message" },
    });

    const { status, body } = await req("GET", `/messages/${agentId}`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    expect(status).toBe(200);
    const found = body.find((m: any) => m.text === "private msg");
    expect(found).toBeDefined();
  });

  test("agent token cannot read another agent's inbox (inbox isolation)", async () => {
    const agentA = id("iso-a");
    const agentB = id("iso-b");
    await req("POST", "/agents/register", { body: { id: agentA, name: "Iso A" } });
    const regB = await req("POST", "/agents/register", { body: { id: agentB, name: "Iso B" } });
    const tokenB: string = regB.body.token;

    // agentB tries to read agentA's inbox
    const { status, body } = await req("GET", `/messages/${agentA}`, {
      headers: { Authorization: `Bearer ${tokenB}`, "Content-Type": "application/json" },
    });
    expect(status).toBe(403);
    expect(body.error).toContain("Forbidden");
  });

  test("master token can read any inbox", async () => {
    const agentId = id("master-read");
    await req("POST", "/agents/register", { body: { id: agentId, name: "Master Read" } });

    const { status } = await req("GET", `/messages/${agentId}`);
    expect(status).toBe(200);
  });
});

// ── GET /messages/:agentId/history ────────────────────────────────────────────

describe("GET /messages/:agentId/history", () => {
  test("returns message history in chronological order", async () => {
    const agentId = id("hist");
    await req("POST", "/agents/register", { body: { id: agentId, name: "Hist Agent" } });

    await req("POST", "/messages", { body: { from: "src", to: agentId, text: "msg1", type: "message" } });
    await req("POST", "/messages", { body: { from: "src", to: agentId, text: "msg2", type: "message" } });

    const { status, body } = await req("GET", `/messages/${agentId}/history?count=10`);
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    const texts = body.map((m: any) => m.text);
    const i1 = texts.indexOf("msg1");
    const i2 = texts.indexOf("msg2");
    expect(i1).toBeGreaterThanOrEqual(0);
    expect(i2).toBeGreaterThan(i1); // chronological
  });
});

// ── Per-agent token access control ───────────────────────────────────────────

describe("Per-agent token access control", () => {
  test("agent token is rejected for /agents/invite (admin only)", async () => {
    const agentId = id("tok-invite");
    const reg = await req("POST", "/agents/register", { body: { id: agentId, name: "Tok Invite" } });
    const token: string = reg.body.token;

    const { status } = await req("POST", "/agents/invite", {
      body: {},
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    expect(status).toBe(403);
  });

  test("invalid token returns 401", async () => {
    const { status } = await req("GET", "/agents", {
      headers: { Authorization: "Bearer completely-fake-token-xyz", "Content-Type": "application/json" },
    });
    expect(status).toBe(401);
  });

  test("missing Authorization header returns 401", async () => {
    const { status } = await req("POST", "/messages", {
      body: { from: "x", to: "y", text: "test" },
      headers: { "Content-Type": "application/json" },
    });
    expect(status).toBe(401);
  });
});

// ── DELETE /agents/:id ────────────────────────────────────────────────────────

describe("DELETE /agents/:id", () => {
  test("soft delete marks agent offline", async () => {
    const agentId = id("del-soft");
    await req("POST", "/agents/register", { body: { id: agentId, name: "Del Soft" } });

    const { status, body } = await req("DELETE", `/agents/${agentId}`);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);

    const raw = await redis.hget("konoha:registry", agentId);
    expect(raw).not.toBeNull();
    const stored = JSON.parse(raw!);
    expect(stored.status).toBe("offline");
  });

  test("hard delete removes agent from registry", async () => {
    const agentId = id("del-hard");
    await req("POST", "/agents/register", { body: { id: agentId, name: "Del Hard" } });

    await req("DELETE", `/agents/${agentId}?hard=true`);

    const raw = await redis.hget("konoha:registry", agentId);
    expect(raw).toBeNull();
  });
});
