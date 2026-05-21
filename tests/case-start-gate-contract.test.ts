import { afterAll, describe, expect, test } from "bun:test";
import { createTestRedis } from "./redis-test-utils";
import { CaseStartGateError } from "../src/runtime/case-start-gate";
import { createCase, deleteCasesByProcess, handleEventFired, listCases, processEventWithActivation } from "../src/runtime";
import { pgDeleteWorkflow } from "../src/storage/pg";
import type { WorkflowDefinition } from "../src/workflow-loader";

process.env.KONOHA_PORT = "0";
process.env.KONOHA_TOKEN ||= "test-admin-token-case-start-gate";
process.env.ANTHROPIC_API_KEY ||= "test-anthropic-key";

const TEST_ADMIN_TOKEN = process.env.KONOHA_TOKEN;
const { app } = await import("../core/src/server");
const redis = createTestRedis();
const RUN = `case-start-gate-${Date.now()}`;
const touched = new Set<string>();

function headers() {
  return { Authorization: `Bearer ${TEST_ADMIN_TOKEN}`, "Content-Type": "application/json" };
}

function workflow(id: string, patch: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id,
    version: "1.0.0",
    name: `Case start gate ${id}`,
    status: "executable",
    lifecycle_state: "executable",
    elements: [
      { id: "start", type: "event", label: "Start", trigger: { kind: "manual", manual_override: true } },
      { id: "task", type: "function", label: "Review", role: "reviewer" },
      { id: "done", type: "event", label: "Done", trigger: { kind: "manual", manual_override: true } },
    ],
    flow: [["start", "task"], ["task", "done"]],
    ...patch,
  };
}

async function putWorkflow(def: WorkflowDefinition): Promise<void> {
  touched.add(def.id);
  await redis.set(`workflow:${def.id}`, JSON.stringify(def));
  await redis.sadd("konoha:workflow:index", def.id);
}

async function cleanupWorkflow(id: string): Promise<void> {
  await deleteCasesByProcess(id).catch(() => 0);
  await redis.del(`workflow:${id}`);
  await redis.srem("konoha:workflow:index", id);
  await pgDeleteWorkflow(id).catch(() => {});
}

afterAll(async () => {
  for (const id of touched) await cleanupWorkflow(id);
  redis.disconnect();
  delete process.env.KONOHA_PORT;
});

describe("case.start executable workflow gate contract", () => {
  test("direct runtime createCase rejects status-only retired legacy workflows", async () => {
    const id = `${RUN}-legacy-archived`;
    await putWorkflow(workflow(id, { status: "archived", lifecycle_state: undefined }));

    try {
      await createCase(id, "direct blocked", {});
      throw new Error("createCase unexpectedly succeeded");
    } catch (error) {
      expect(error).toBeInstanceOf(CaseStartGateError);
      expect((error as CaseStartGateError).status).toBe(409);
      expect((error as CaseStartGateError).data).toMatchObject({
        code: "WORKFLOW_NOT_EXECUTABLE",
        process_id: id,
        lifecycle_state: "retired",
        required_lifecycle_state: "executable",
      });
    }
  });

  test("POST /cases compatibility route returns structured gate errors for legacy needs_review records", async () => {
    const id = `${RUN}-legacy-needs-review`;
    await putWorkflow(workflow(id, { status: "needs_review", lifecycle_state: undefined }));

    const res = await app.fetch(new Request("http://localhost/cases", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ process_id: id, subject: "api blocked", payload: {} }),
    }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toMatchObject({
      code: "WORKFLOW_NOT_EXECUTABLE",
      process_id: id,
      lifecycle_state: "validated",
      required_lifecycle_state: "executable",
    });
  });

  test("public trigger route uses the same executable gate for lifecycle_state records", async () => {
    const id = `${RUN}-retired-lifecycle`;
    await putWorkflow(workflow(id, { status: "retired", lifecycle_state: "retired" }));

    const res = await app.fetch(new Request(`http://localhost/trigger/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject: "trigger blocked", payload: {} }),
    }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toMatchObject({
      code: "WORKFLOW_NOT_EXECUTABLE",
      process_id: id,
      lifecycle_state: "retired",
    });
  });

  test("event auto-start paths cannot create cases for executable but invalid workflows", async () => {
    const id = `${RUN}-invalid-event-start`;
    await putWorkflow(workflow(id, {
      elements: [
        { id: "start", type: "event", label: "Webhook start", trigger: { kind: "message", source: "webhook" } },
        { id: "task", type: "function", label: "Review", role: "reviewer" },
      ],
      flow: [["start", "task"]],
      triggers: [{ event_type: "webhook.received", start_node: "start" }],
    }));

    const routed = await processEventWithActivation(
      "webhook.received",
      "webhook",
      { subject: "event blocked" },
      { workflowIds: [id] },
    );
    const fired = await handleEventFired({
      event_id: "start",
      process_id: id,
      instance_id: "new",
      source_data: { subject: "subscription blocked" },
      idempotency_key: `${id}-dedup`,
    });
    const cases = await listCases({ process_id: id, limit: 10 });

    expect(routed.cases).toEqual([]);
    expect(fired).toBeNull();
    expect(cases.total).toBe(0);
  });
});
