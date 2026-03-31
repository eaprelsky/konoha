/**
 * KWE-006: Tsunade event handler tests
 *
 * Tests that Tsunade registers on the bus and that events are routed
 * to naruto/assignee as messages. Uses real Redis.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import Redis from "ioredis";

// Read the token from env (server.ts captures it at module-load time;
// Bun caches the module across test files, so mutating process.env here
// would be too late and cause 401s in both this file and others).
const TEST_TOKEN = process.env.KONOHA_TOKEN || "konoha-dev-token";
process.env.KONOHA_PORT = "0";

const { app } = await import("../src/server");

const redis = new Redis({ host: "127.0.0.1", port: 6379 });

function adminHeaders() {
  return { Authorization: `Bearer ${TEST_TOKEN}`, "Content-Type": "application/json" };
}

async function req(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: adminHeaders() };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await app.fetch(new Request(`http://localhost${path}`, init));
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

// Wait up to maxMs for a condition to become true
async function waitFor(check: () => Promise<boolean>, maxMs = 5000): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

afterAll(async () => {
  redis.disconnect();
});

describe("Tsunade registration", () => {
  test("tsunade is registered on the bus with correct subscriptions", async () => {
    // Wait for initTsunade to complete (async on startup)
    const registered = await waitFor(async () => {
      const raw = await redis.hget("konoha:registry", "tsunade");
      return !!raw;
    });
    expect(registered).toBe(true);

    const raw = await redis.hget("konoha:registry", "tsunade");
    const agent = JSON.parse(raw!);
    expect(agent.id).toBe("tsunade");
    expect(agent.roles).toContain("architect");
    expect(agent.eventSubscriptions).toContain("process.exception");
    expect(agent.eventSubscriptions).toContain("workitem.stuck");
    expect(agent.eventSubscriptions).toContain("workitem.overdue");
  });
});

describe("Tsunade event routing", () => {
  test("process.exception event delivers message to naruto", async () => {
    // Register naruto for this test (or use existing)
    await req("POST", "/agents/register", { id: "naruto", name: "Naruto Test" });

    // Publish process.exception event
    await req("POST", "/events", {
      type: "process.exception",
      source: "runtime@comind.konoha",
      payload: { case_id: "case-test-001", error: "unexpected terminal" },
      village_id: "comind.konoha",
    });

    // Wait for Tsunade to process and deliver message to naruto
    const delivered = await waitFor(async () => {
      const msgs = await redis.xrange("konoha:agent:naruto", "-", "+");
      return msgs.some(([, fields]) => {
        const obj: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
        return obj.from === "tsunade" && obj.text?.includes("case-test-001");
      });
    });
    expect(delivered).toBe(true);
  });

  test("workitem.stuck event delivers message to assignee", async () => {
    const assigneeId = `test-stuck-assignee-${Date.now()}`;
    await req("POST", "/agents/register", { id: assigneeId, name: "Stuck Assignee" });

    await req("POST", "/events", {
      type: "workitem.stuck",
      source: "runtime@comind.konoha",
      payload: { work_item_id: "wi-stuck-001", assignee: assigneeId, label: "Qualify lead" },
      village_id: "comind.konoha",
    });

    const delivered = await waitFor(async () => {
      const msgs = await redis.xrange(`konoha:agent:${assigneeId}`, "-", "+");
      return msgs.some(([, fields]) => {
        const obj: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
        return obj.from === "tsunade" && obj.text?.includes("wi-stuck-001");
      });
    });
    expect(delivered).toBe(true);

    // Cleanup
    await req("DELETE", `/agents/${assigneeId}?hard=true`);
  });

  test("workitem.overdue event delivers message to assignee with deadline", async () => {
    const assigneeId = `test-overdue-assignee-${Date.now()}`;
    await req("POST", "/agents/register", { id: assigneeId, name: "Overdue Assignee" });

    await req("POST", "/events", {
      type: "workitem.overdue",
      source: "runtime@comind.konoha",
      payload: {
        work_item_id: "wi-overdue-001",
        assignee: assigneeId,
        label: "Send proposal",
        deadline: "2026-03-31T12:00:00Z",
      },
      village_id: "comind.konoha",
    });

    const delivered = await waitFor(async () => {
      const msgs = await redis.xrange(`konoha:agent:${assigneeId}`, "-", "+");
      return msgs.some(([, fields]) => {
        const obj: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
        return obj.from === "tsunade" && obj.text?.includes("wi-overdue-001") && obj.text?.includes("2026-03-31");
      });
    });
    expect(delivered).toBe(true);

    // Cleanup
    await req("DELETE", `/agents/${assigneeId}?hard=true`);
  });
});
