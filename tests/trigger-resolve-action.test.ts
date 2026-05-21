import { afterAll, describe, expect, mock, test } from "bun:test";
import { createTestRedis } from "./redis-test-utils";
import type { WorkflowDefinition, WorkflowElement } from "../src/workflow-loader";

mock.module("../src/trigger-resolver", () => ({
  resolveBatchProgrammatic: async (events: { id: string; label: string }[]) => {
    return events.map(event => {
      if (event.label.includes("resolver failure")) throw new Error("resolver offline");
      if (event.label.includes("ambiguous")) {
        return {
          id: event.id,
          trigger: {
            kind: "ambiguous",
            candidates: [{ kind: "timer", confidence: 0.42 }],
            confidence: 0.42,
          },
        };
      }
      return {
        id: event.id,
        trigger: {
          kind: "message",
          source: "bus",
          filter: { event_type: "workflow.started" },
          confidence: 0.91,
        },
      };
    });
  },
}));

const { executeActionDirect } = await import("../src/action-executor");
const { deleteCasesByProcess } = await import("../src/runtime");
const { SUBSCRIPTIONS_KEY } = await import("../src/events/subscriptions");
const { pgDeleteWorkflow } = await import("../src/storage/pg");
const { createWorkflow, getWorkflow } = await import("../src/workflow-loader");

const redis = createTestRedis();
const RUN = `trigger-resolve-${Date.now()}`;
const touched = new Set<string>();

function workflow(id: string, trigger?: WorkflowElement["trigger"], label = "high-confidence bus event"): WorkflowDefinition {
  return {
    id,
    version: "1.0.0",
    name: `Trigger resolve ${id}`,
    elements: [
      { id: "start", type: "event", label, ...(trigger ? { trigger } : {}) },
      { id: "task", type: "function", label: "Handle event", role: "reviewer" },
      { id: "done", type: "event", label: "Done", trigger: { kind: "manual", manual_override: true } },
    ],
    flow: [["start", "task"], ["task", "done"]],
  };
}

async function saveDraft(def: WorkflowDefinition): Promise<void> {
  touched.add(def.id);
  await createWorkflow(def, { draft: true });
}

async function cleanupWorkflow(id: string): Promise<void> {
  await deleteCasesByProcess(id).catch(() => 0);
  await redis.del(`workflow:${id}`);
  await redis.srem("konoha:workflow:index", id);
  await pgDeleteWorkflow(id).catch(() => {});
}

async function activeSubscriptionsForProcess(id: string): Promise<number> {
  const raw = await redis.hgetall(SUBSCRIPTIONS_KEY).catch(() => ({} as Record<string, string>));
  return Object.values(raw).filter(value => {
    try {
      const sub = JSON.parse(value);
      return sub.process_id === id && sub.status === "active";
    } catch {
      return false;
    }
  }).length;
}

afterAll(async () => {
  for (const id of touched) await cleanupWorkflow(id);
  redis.disconnect();
});

describe("trigger.resolve deterministic review receipts", () => {
  test("returns explicit no-review receipt for high-confidence resolver success", async () => {
    const id = `${RUN}-success`;
    await saveDraft(workflow(id));

    const resolved = await executeActionDirect("trigger.resolve", {
      workflow_id: id,
      element_id: "start",
      expected_edit_version: 1,
    });

    expect(resolved?.status).toBe(200);
    expect(resolved?.data).toMatchObject({
      resolution_status: "resolved",
      review_status: "not_required",
      review_required: false,
      confidence: 0.91,
      trigger_kind: "message",
      trigger: { kind: "message", confidence: 0.91 },
      edit_version: 2,
    });
  });

  test("returns review-required receipt for ambiguous output and deploy blocks it", async () => {
    const id = `${RUN}-ambiguous`;
    await saveDraft(workflow(id, undefined, "ambiguous customer event"));

    const resolved = await executeActionDirect("trigger.resolve", {
      workflow_id: id,
      element_id: "start",
      expected_edit_version: 1,
    });

    expect(resolved?.status).toBe(200);
    expect(resolved?.data).toMatchObject({
      resolution_status: "ambiguous",
      review_status: "required",
      review_required: true,
      confidence: 0.42,
      trigger_kind: "ambiguous",
      trigger: { kind: "ambiguous", confidence: 0.42 },
    });

    const deploy = await executeActionDirect("workflow.deploy", { id });
    expect(deploy?.status).toBe(422);
    expect((deploy?.data as any)).toMatchObject({
      code: "WORKFLOW_VALIDATION_BLOCKED",
      process_id: id,
      lifecycle_state: "validated",
      validation: { readiness: "blocked" },
    });
    expect((deploy?.data as any).validation.errors).toContainEqual(expect.objectContaining({
      code: "TRIGGER_AMBIGUOUS",
      class: "trigger",
    }));
    expect(await activeSubscriptionsForProcess(id)).toBe(0);
  });

  test("skips manual override without mutating edit_version", async () => {
    const id = `${RUN}-manual`;
    await saveDraft(workflow(id, { kind: "manual", manual_override: true, confidence: 1 }));

    const resolved = await executeActionDirect("trigger.resolve", {
      workflow_id: id,
      element_id: "start",
      expected_edit_version: 1,
    });

    expect(resolved?.status).toBe(200);
    expect(resolved?.data).toMatchObject({
      skipped: true,
      reason: "manual_override",
      resolution_status: "manual_override",
      review_status: "skipped",
      review_required: false,
      confidence: 1,
      trigger_kind: "manual",
      edit_version: 1,
    });
  });

  test("returns review-required failure receipt and does not deploy silently", async () => {
    const id = `${RUN}-failure`;
    await saveDraft(workflow(id, undefined, "resolver failure event"));

    const resolved = await executeActionDirect("trigger.resolve", {
      workflow_id: id,
      element_id: "start",
      expected_edit_version: 1,
    });

    expect(resolved?.status).toBe(200);
    expect(resolved?.data).toMatchObject({
      resolution_status: "failed",
      review_status: "required",
      review_required: true,
      confidence: 0,
      trigger_kind: "ambiguous",
      resolver_error: "resolver offline",
      trigger: { kind: "ambiguous", confidence: 0, error: "resolver offline" },
    });

    const deploy = await executeActionDirect("workflow.deploy", { id });
    expect(deploy?.status).toBe(422);
    expect((deploy?.data as any).validation.errors.map((error: any) => error.code)).toContain("TRIGGER_AMBIGUOUS");
    expect(await activeSubscriptionsForProcess(id)).toBe(0);
  });

  test("version conflicts return explicit not-evaluated receipt and preserve workflow state", async () => {
    const id = `${RUN}-conflict`;
    await saveDraft(workflow(id));

    const resolved = await executeActionDirect("trigger.resolve", {
      workflow_id: id,
      element_id: "start",
      expected_edit_version: 99,
    });

    expect(resolved?.status).toBe(409);
    expect(resolved?.data).toMatchObject({
      code: "WORKFLOW_UPDATE_CONFLICT",
      resolution_status: "conflict",
      review_status: "not_evaluated",
      review_required: false,
      confidence: null,
    });

    const current = await getWorkflow(id);
    expect(current?.elements.find(element => element.id === "start")?.trigger).toBeUndefined();
  });
});
