import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import Redis from "ioredis";
import { AUTONOMY_KEY } from "../src/assistant-actions";

process.env.KONOHA_PORT = "0";
process.env.ANTHROPIC_API_KEY ||= "test-anthropic-key";

const TEST_ADMIN_TOKEN = process.env.KONOHA_TOKEN || "test-admin-token-preload";
const { app } = await import("../core/src/server");
const redis = new Redis({ host: "127.0.0.1", port: 6379, db: parseInt(process.env.REDIS_DB ?? "0") });

const RUN = `act-wf-${Date.now()}`;
const ACT_WORKFLOW_ID = `${RUN}-direct`;
const HTTP_WORKFLOW_ID_PREFIX = `${RUN}-http`;
const savedAutonomy: Record<string, string | null> = {};

function adminHeaders() {
  return { Authorization: `Bearer ${TEST_ADMIN_TOKEN}`, "Content-Type": "application/json" };
}

async function cleanupWorkflow(id: string) {
  await redis.srem("konoha:workflow:index", id);
  await redis.del(`workflow:${id}`);
}

beforeAll(async () => {
  for (const action of ["workflow.create", "workflow.update", "workflow.delete"]) {
    savedAutonomy[action] = await redis.hget(AUTONOMY_KEY, action);
    await redis.hset(AUTONOMY_KEY, action, "auto");
  }
});

afterAll(async () => {
  for (const [action, value] of Object.entries(savedAutonomy)) {
    if (value == null) await redis.hdel(AUTONOMY_KEY, action);
    else await redis.hset(AUTONOMY_KEY, action, value);
  }

  await cleanupWorkflow(ACT_WORKFLOW_ID);
  const ids = await redis.smembers("konoha:workflow:index");
  for (const id of ids) {
    if (id.startsWith(HTTP_WORKFLOW_ID_PREFIX)) await cleanupWorkflow(id);
  }
  redis.disconnect();
  delete process.env.KONOHA_PORT;
});

describe("/act workflow executor", () => {
  test("executes workflow.create directly through the action envelope", async () => {
    const res = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        action: "workflow.create",
        category: "act",
        args: {
          id: ACT_WORKFLOW_ID,
          name: "Action executor workflow",
          elements: [],
          flow: [],
          draft: true,
        },
        meta: { session_id: `${RUN}-create-test` },
      }),
    }));

    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.ok).toBe(true);
    expect(body.action).toBe("workflow.create");
    expect(body.data.id).toBe(ACT_WORKFLOW_ID);
    expect(body.data.normalized).toBe(false);
  });

  test("executes workflow.update directly through the action envelope", async () => {
    const res = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        action: "workflow.update",
        category: "act",
        args: {
          id: ACT_WORKFLOW_ID,
          name: "Updated action executor workflow",
          draft: true,
        },
        meta: { session_id: `${RUN}-update-test` },
      }),
    }));

    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.action).toBe("workflow.update");
    expect(body.data.name).toBe("Updated action executor workflow");
  });

  test("keeps legacy /workflows create as a compatibility wrapper with defaults", async () => {
    const id = `${HTTP_WORKFLOW_ID_PREFIX}-wrapper`;
    const res = await app.fetch(new Request("http://localhost/workflows?draft=true", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ id, name: "HTTP wrapper workflow" }),
    }));

    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.id).toBe(id);
    expect(body.elements).toEqual([]);
    expect(body.flow).toEqual([]);
  });
});
