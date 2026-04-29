/**
 * Konoha server unit tests — bun test
 *
 * Tests run against the real Hono app (app.fetch) + real Redis.
 * Test-specific agent IDs are prefixed with "test-" and cleaned up in afterAll.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import Redis from "ioredis";
import { rmSync, writeFileSync } from "fs";
import { cleanupGeneratedTestAgents } from "./agent-registry-cleanup";

// Use the test admin token set by tests/setup.ts preload.
// Setting KONOHA_PORT=0 prevents the server from binding a real port.
const TEST_ADMIN_TOKEN = process.env.KONOHA_TOKEN || "test-admin-token-preload";
process.env.KONOHA_PORT = "0";

const { app } = await import("../core/src/server");

// ── helpers ───────────────────────────────────────────────────────────────────

const redis = new Redis({ host: "127.0.0.1", port: 6379, db: parseInt(process.env.REDIS_DB ?? "0") });

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
  await cleanupGeneratedTestAgents();
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
  await redis.flushdb();
  redis.disconnect();
  if (process.env.KONOHA_SETUP_FILE) rmSync(process.env.KONOHA_SETUP_FILE, { force: true });
  delete process.env.KONOHA_PORT;
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

// ── Dashboard auth ───────────────────────────────────────────────────────────

describe("Dashboard auth", () => {
  test("rejects wrong dashboard password", async () => {
    const { status } = await req("POST", "/auth/login", {
      body: { username: "test-admin", password: "wrong-password" },
      headers: { "Content-Type": "application/json" },
    });
    expect(status).toBe(401);
  });

  test("rate-limits repeated dashboard login failures", async () => {
    const headers = { "Content-Type": "application/json", "X-Real-IP": `10.0.0.${RUN.slice(-3)}` };
    let status = 0;
    for (let i = 0; i < 10; i += 1) {
      const res = await req("POST", "/auth/login", {
        body: { username: `rate-test-${RUN}`, password: "wrong-password" },
        headers,
      });
      status = res.status;
    }
    expect(status).toBe(401);

    const blocked = await req("POST", "/auth/login", {
      body: { username: `rate-test-${RUN}`, password: "wrong-password" },
      headers,
    });
    expect(blocked.status).toBe(429);
  });

  test("creates httpOnly dashboard session and authenticates API without bearer", async () => {
    const login = await req("POST", "/auth/login", {
      body: { username: "test-admin", password: "test-dashboard-password" },
      headers: { "Content-Type": "application/json" },
    });
    expect(login.status).toBe(200);

    const cookie = login.body ? "" : "";
    const rawLogin = await app.fetch(new Request("http://localhost/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "test-admin", password: "test-dashboard-password" }),
    }));
    const setCookie = rawLogin.headers.get("set-cookie") || cookie;
    expect(setCookie).toContain("konoha_dash_session=");
    expect(setCookie.toLowerCase()).toContain("httponly");

    const sessionCookie = setCookie.split(";")[0];
    const me = await req("GET", "/auth/me", {
      headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
    });
    expect(me.status).toBe(200);
    expect(me.body.authenticated).toBe(true);

    const agents = await req("GET", "/agents", {
      headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
    });
    expect(agents.status).toBe(200);
  });

  test("dashboard profile is saved separately from people directory", async () => {
    const rawLogin = await app.fetch(new Request("http://localhost/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Real-IP": `10.0.3.${RUN.slice(-3)}` },
      body: JSON.stringify({ username: "test-admin", password: "test-dashboard-password" }),
    }));
    const sessionCookie = (rawLogin.headers.get("set-cookie") || "").split(";")[0];
    expect(sessionCookie).toContain("konoha_dash_session=");

    const listed = await req("GET", "/people");
    const trusted = Array.isArray(listed.body)
      ? listed.body.find((person: any) => person.id && person.source !== "custom")
      : null;

    const saved = await req("PUT", "/profile/me", {
      headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
      body: {
        display_name: "Dashboard Owner",
        position: "Owner",
        person_id: trusted?.id,
        capabilities: ["profile-test"],
      },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.username).toBe("test-admin");
    expect(saved.body.display_name).toBe("Dashboard Owner");
    expect(saved.body.person_id).toBe(trusted?.id);

    const profile = await req("GET", "/profile/me", {
      headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
    });
    expect(profile.status).toBe(200);
    expect(profile.body.display_name).toBe("Dashboard Owner");

    if (trusted?.id) {
      expect(await redis.hget("people:custom", trusted.id)).toBeNull();
    }
  });

  test("dashboard host rejects injected bearer without dashboard session", async () => {
    const { status } = await req("GET", "/agents", {
      headers: {
        Host: "dashboard.test",
        Authorization: `Bearer ${TEST_ADMIN_TOKEN}`,
        "Content-Type": "application/json",
      },
    });
    expect(status).toBe(401);
  });

  test("rate-limits repeated password change failures", async () => {
    const rawLogin = await app.fetch(new Request("http://localhost/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Real-IP": `10.0.1.${RUN.slice(-3)}` },
      body: JSON.stringify({ username: "test-admin", password: "test-dashboard-password" }),
    }));
    const sessionCookie = (rawLogin.headers.get("set-cookie") || "").split(";")[0];
    expect(sessionCookie).toContain("konoha_dash_session=");

    const headers = {
      Cookie: sessionCookie,
      "Content-Type": "application/json",
      "X-Real-IP": `10.0.2.${RUN.slice(-3)}`,
    };
    let status = 0;
    for (let i = 0; i < 5; i += 1) {
      const res = await req("POST", "/auth/password", {
        body: { current_password: "wrong-password", new_password: "new-dashboard-password" },
        headers,
      });
      status = res.status;
    }
    expect(status).toBe(403);

    const blocked = await req("POST", "/auth/password", {
      body: { current_password: "wrong-password", new_password: "new-dashboard-password" },
      headers,
    });
    expect(blocked.status).toBe(429);
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

// ── PUT /agents/:id ─────────────────────────────────────────────────────────

describe("PUT /agents/:id", () => {
  test("updates product-facing display alias through agent.update_profile action", async () => {
    const agentId = id("profile-alias");
    await req("POST", "/agents", {
      body: {
        id: agentId,
        name: "Runtime Sasuke",
        model: "claude:sonnet",
      },
    });

    const { status, body } = await req("PUT", `/agents/${agentId}`, {
      body: {
        name: "Runtime Sasuke",
        display_alias: "Sales Assistant",
      },
    });

    expect(status).toBe(200);
    expect(body.id).toBe(agentId);
    expect(body.name).toBe("Runtime Sasuke");
    expect(body.display_alias).toBe("Sales Assistant");

    const listed = await req("GET", "/agents");
    const found = listed.body.find((a: any) => a.id === agentId);
    expect(found.display_alias).toBe("Sales Assistant");
  });

  test("rejects empty profile update", async () => {
    const agentId = id("profile-empty");
    await req("POST", "/agents", {
      body: {
        id: agentId,
        name: "Profile Empty",
        model: "claude:sonnet",
      },
    });

    const { status, body } = await req("PUT", `/agents/${agentId}`, { body: {} });
    expect(status).toBe(400);
    expect(body.error).toBe("No fields to update");
  });
});

// ── POST /agents/:id/switch-runtime ─────────────────────────────────────────

describe("POST /agents/:id/switch-runtime", () => {
  test("switches managed agent to a named runtime profile", async () => {
    const agentId = id("switch-runtime");
    await req("POST", "/agents", {
      body: {
        id: agentId,
        name: "Runtime Switch Agent",
        runtime: "codex",
        model: "gpt-5.4",
        runtime_profiles: {
          codex: { runtime: "codex", model: "gpt-5.4" },
          glm: { runtime: "glm", model: "glm-5.1" },
        },
        active_runtime_profile: "codex",
      },
    });

    const { status, body } = await req("POST", `/agents/${agentId}/switch-runtime`, {
      body: { profile: "glm", restart: false },
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.active_runtime_profile).toBe("glm");
    expect(body.runtime).toBe("glm");
    expect(body.model).toBe("glm-5.1");

    const updated = await req("GET", `/agents/${agentId}`);
    expect(updated.body.active_runtime_profile).toBe("glm");
    expect(updated.body.runtime).toBe("glm");
    expect(updated.body.model).toBe("glm-5.1");
  });

  test("returns 404 for unknown runtime profile", async () => {
    const agentId = id("switch-runtime-missing");
    await req("POST", "/agents", {
      body: {
        id: agentId,
        name: "Runtime Switch Missing Profile Agent",
        runtime: "codex",
        model: "gpt-5.4",
        runtime_profiles: {
          codex: { runtime: "codex", model: "gpt-5.4" },
        },
        active_runtime_profile: "codex",
      },
    });

    const { status, body } = await req("POST", `/agents/${agentId}/switch-runtime`, {
      body: { profile: "glm", restart: false },
    });
    expect(status).toBe(404);
    expect(body.error).toContain("Runtime profile not found");
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

    const listed = await req("GET", "/agents");
    const stored = listed.body.find((a: any) => a.id === agentId);
    expect(stored).toBeDefined();
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

// ── User-visible configuration access control ────────────────────────────────

describe("User-visible configuration access control", () => {
  test("agent token cannot update branding", async () => {
    const agentId = id("branding-token");
    const reg = await req("POST", "/agents/register", { body: { id: agentId, name: "Branding Token" } });
    const token: string = reg.body.token;

    const { status } = await req("PUT", "/branding", {
      body: { product_name: "Blocked Defacement" },
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });

    expect(status).toBe(403);
  });

  test("agent token cannot update autonomy matrix", async () => {
    const agentId = id("autonomy-token");
    const reg = await req("POST", "/agents/register", { body: { id: agentId, name: "Autonomy Token" } });
    const token: string = reg.body.token;

    const { status } = await req("PUT", "/config/autonomy", {
      body: { "github.issue.create": "auto" },
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });

    expect(status).toBe(403);
  });

  test("agent token cannot update deploy settings", async () => {
    const agentId = id("deploy-settings-token");
    const reg = await req("POST", "/agents/register", { body: { id: agentId, name: "Deploy Settings Token" } });
    const token: string = reg.body.token;

    const { status } = await req("PUT", "/config/settings", {
      body: { auto_deploy: true },
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });

    expect(status).toBe(403);
  });

  test("agent token cannot trigger deploy", async () => {
    const agentId = id("deploy-token");
    const reg = await req("POST", "/agents/register", { body: { id: agentId, name: "Deploy Token" } });
    const token: string = reg.body.token;

    const { status } = await req("POST", "/deploy", {
      body: { force: false },
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });

    expect(status).toBe(403);
  });

  test("agent token cannot mutate whitelist", async () => {
    const agentId = id("whitelist-token");
    const reg = await req("POST", "/agents/register", { body: { id: agentId, name: "Whitelist Token" } });
    const token: string = reg.body.token;

    const { status } = await req("POST", "/whitelist/approve", {
      body: { type: "user", telegram_id: 123456 },
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });

    expect(status).toBe(403);
  });

  test("agent token cannot seed system agents", async () => {
    const agentId = id("seed-token");
    const reg = await req("POST", "/agents/register", { body: { id: agentId, name: "Seed Token" } });
    const token: string = reg.body.token;

    const { status } = await req("POST", "/admin/seed-system-agents", {
      body: {},
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });

    expect(status).toBe(403);
  });

  test("completed setup cannot be overwritten without admin auth", async () => {
    const setupFile = process.env.KONOHA_SETUP_FILE;
    if (!setupFile) throw new Error("KONOHA_SETUP_FILE must be set in tests");
    writeFileSync(setupFile, JSON.stringify({ complete: true, owner_tg_id: "1" }));

    const { status } = await req("POST", "/setup", {
      body: { owner_tg_id: "2", github_pat: "blocked-token" },
      headers: { "Content-Type": "application/json" },
    });

    expect(status).toBe(403);
  });

  test("admin token can update branding", async () => {
    const { status, body } = await req("PUT", "/branding", {
      body: { product_name: "Konoha WE", theme: { primary_color: "#6366f1" } },
    });

    expect(status).toBe(200);
    expect(body.product_name).toBe("Konoha WE");
    expect(body.theme.primary_color).toBe("#6366f1");

    const audit = await req("GET", "/audit?action_type=branding.update&limit=5");
    expect(audit.status).toBe(200);
    expect(audit.body.some((entry: any) => entry.action_type === "branding.update" && entry.result === "ok")).toBe(true);
  });

  test("agent token cannot create custom people", async () => {
    const agentId = id("people-token");
    const personId = id("blocked-person");
    const reg = await req("POST", "/agents/register", { body: { id: agentId, name: "People Token" } });
    const token: string = reg.body.token;

    const { status } = await req("POST", "/people", {
      body: { id: personId, name: "Blocked Person", position: "Blocked" },
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });

    expect(status).toBe(403);
    expect(await redis.hget("people:custom", personId)).toBeNull();
  });

  test("admin token can create and delete custom people", async () => {
    const personId = id("custom-person");

    const created = await req("POST", "/people", {
      body: { id: personId, name: "Custom Person", position: "QA" },
    });
    expect(created.status).toBe(201);
    expect(created.body.id).toBe(personId);

    const deleted = await req("DELETE", `/people/${personId}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body.ok).toBe(true);

    const audit = await req("GET", "/audit?limit=20");
    const actions = audit.body.map((entry: any) => entry.action_type);
    expect(actions).toContain("person.upsert");
    expect(actions).toContain("person.delete");
  });

  test("custom people cannot override file-based trusted users", async () => {
    const listed = await req("GET", "/people");
    const trusted = Array.isArray(listed.body)
      ? listed.body.find((person: any) => person.id && person.source !== "custom")
      : null;
    if (!trusted) return;

    const { status } = await req("POST", "/people", {
      body: { id: trusted.id, name: "Blocked Override", position: "Blocked" },
    });

    expect(status).toBe(409);
  });
});

// ── Route RBAC policy ───────────────────────────────────────────────────────

describe("Route RBAC policy", () => {
  test("agent token cannot manage agent definitions or lifecycle", async () => {
    const agentId = id("rbac-agent");
    const reg = await req("POST", "/agents/register", { body: { id: agentId, name: "RBAC Agent" } });
    const token: string = reg.body.token;

    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    expect((await req("GET", "/agents", { headers })).status).toBe(403);
    expect((await req("POST", "/agents", {
      body: { id: id("blocked-managed"), name: "Blocked Managed", model: "claude:sonnet" },
      headers,
    })).status).toBe(403);
    expect((await req("POST", `/agents/${agentId}/start`, { body: {}, headers })).status).toBe(403);
    expect((await req("POST", `/agents/${agentId}/switch-runtime`, {
      body: { llm_client_profile: "claude-deepseek-haiku" },
      headers,
    })).status).toBe(403);
    expect((await req("DELETE", `/agents/${agentId}`, { headers })).status).toBe(403);
  });

  test("agent token can inspect self but not another agent", async () => {
    const selfId = id("rbac-self");
    const otherId = id("rbac-other");
    await req("POST", "/agents", { body: { id: selfId, name: "RBAC Self", model: "claude:sonnet" } });
    await req("POST", "/agents", { body: { id: otherId, name: "RBAC Other", model: "claude:sonnet" } });
    const reg = await req("POST", "/agents/register", { body: { id: selfId, name: "RBAC Self" } });
    const token: string = reg.body.token;
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    expect((await req("GET", `/agents/${selfId}`, { headers })).status).toBe(200);
    expect((await req("GET", `/agents/${selfId}/status`, { headers })).status).toBe(200);
    expect((await req("GET", `/agents/${otherId}`, { headers })).status).toBe(403);
    expect((await req("GET", `/agents/${otherId}/status`, { headers })).status).toBe(403);
  });

  test("agent token cannot mutate workflows through direct CRUD routes", async () => {
    const agentId = id("rbac-workflow");
    const reg = await req("POST", "/agents/register", { body: { id: agentId, name: "RBAC Workflow" } });
    const token: string = reg.body.token;

    const { status } = await req("POST", "/workflows", {
      body: { id: id("blocked-workflow"), elements: [], flow: [], draft: true },
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });

    expect(status).toBe(403);
  });

  test("work item direct routes enforce assignee ownership for agent tokens", async () => {
    const assigneeId = id("rbac-assignee");
    const otherId = id("rbac-non-assignee");
    const assigneeReg = await req("POST", "/agents/register", { body: { id: assigneeId, name: "RBAC Assignee" } });
    const otherReg = await req("POST", "/agents/register", { body: { id: otherId, name: "RBAC Non Assignee" } });
    const created = await req("POST", "/workitems", {
      body: { label: "RBAC task", assignee: assigneeId, input: {} },
    });
    expect(created.status).toBe(201);
    const workItemId = created.body.work_item_id;

    const otherHeaders = { Authorization: `Bearer ${otherReg.body.token}`, "Content-Type": "application/json" };
    expect((await req("GET", `/workitems?assignee=${assigneeId}`, { headers: otherHeaders })).status).toBe(403);
    expect((await req("POST", `/workitems/${workItemId}/complete`, {
      body: { output: { blocked: true } },
      headers: otherHeaders,
    })).status).toBe(403);

    const ownHeaders = { Authorization: `Bearer ${assigneeReg.body.token}`, "Content-Type": "application/json" };
    expect((await req("POST", `/workitems/${workItemId}/complete`, {
      body: { output: { ok: true } },
      headers: ownHeaders,
    })).status).toBe(200);
  });

  test("agent token cannot mutate event subscriptions, calendar overrides, or reminders directly", async () => {
    const agentId = id("rbac-ops");
    const reg = await req("POST", "/agents/register", { body: { id: agentId, name: "RBAC Ops" } });
    const headers = { Authorization: `Bearer ${reg.body.token}`, "Content-Type": "application/json" };

    expect((await req("POST", "/event-manager/subscribe", {
      body: { event_id: "start", process_id: "p", instance_id: "i", trigger: { kind: "manual" } },
      headers,
    })).status).toBe(403);
    expect((await req("POST", "/work-calendar/override", {
      body: { date: "2026-05-01", status: "holiday" },
      headers,
    })).status).toBe(403);
    expect((await req("POST", "/roles", {
      body: { role_id: id("blocked-role"), name: "Blocked role" },
      headers,
    })).status).toBe(403);
    expect((await req("POST", "/reminders", {
      body: {
        recipient: agentId,
        message: "blocked",
        scheduled_at: new Date(Date.now() + 60_000).toISOString(),
      },
      headers,
    })).status).toBe(403);
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

    const listed = await req("GET", "/agents");
    const stored = listed.body.find((a: any) => a.id === agentId);
    expect(stored).toBeDefined();
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
