import { afterAll, describe, expect, test } from "bun:test";
import { createTestRedis } from "./redis-test-utils";
import { deleteCasesByProcess } from "../src/runtime";
import { deleteRole } from "../src/runtime/roles";
import { pgDeleteWorkflow } from "../src/storage/pg";

process.env.KONOHA_PORT = "0";
process.env.ANTHROPIC_API_KEY ||= "test-anthropic-key";

const TEST_ADMIN_TOKEN = process.env.KONOHA_TOKEN || "test-admin-token-preload";
const { app } = await import("../core/src/server");
const redis = createTestRedis();
const RUN = `validation-api-${Date.now()}`;
const WORKFLOW_ID = `${RUN}-workflow`;
const ROLE_ID = `${RUN}-role`;

function adminHeaders() {
  return { Authorization: `Bearer ${TEST_ADMIN_TOKEN}`, "Content-Type": "application/json" };
}

afterAll(async () => {
  await deleteCasesByProcess(WORKFLOW_ID).catch(() => 0);
  await redis.srem("konoha:workflow:index", WORKFLOW_ID);
  await redis.del(`workflow:${WORKFLOW_ID}`);
  await pgDeleteWorkflow(WORKFLOW_ID).catch(() => {});
  await deleteRole(ROLE_ID).catch(() => {});
  redis.disconnect();
  delete process.env.KONOHA_PORT;
});

describe("workflow validation API", () => {
  test("returns canonical machine-readable validation receipt for frontend diagnostics", async () => {
    const createRes = await app.fetch(new Request("http://localhost/workflows?draft=true", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        id: WORKFLOW_ID,
        name: "Validation API workflow",
        elements: [
          { id: "start", type: "event", label: "Start", trigger: { kind: "timer", cron: "*/5 * * * *", confidence: 1 } },
          { id: "task", type: "function", label: "Review", role: ROLE_ID, systems: [{ connector: "missing-adapter", operation: "send" }] },
          { id: "done", type: "event", label: "Done", trigger: { kind: "manual", manual_override: true } },
        ],
        flow: [["start", "task"], ["task", "done"]],
      }),
    }));
    expect(createRes.status).toBe(201);

    const validationRes = await app.fetch(new Request(`http://localhost/workflows/${WORKFLOW_ID}/validation?source=workflow.deploy`, {
      method: "GET",
      headers: adminHeaders(),
    }));
    const body = await validationRes.json();

    expect(validationRes.status).toBe(200);
    expect(body).toMatchObject({
      workflow_id: WORKFLOW_ID,
      source: "workflow.deploy",
      readiness: "blocked",
      gates: {
        deployment_blocker: true,
        case_start_blocker: true,
      },
    });
    expect(body.errors).toContainEqual(expect.objectContaining({
      code: "ADAPTER_MISSING",
      class: "adapter",
      element_id: "task",
      legacy_code: "RUNTIME_MISSING_ADAPTER",
    }));
  });
});
