import { afterAll, describe, expect, test } from "bun:test";
import { executeActionDirect } from "../src/action-executor";
import { SUBSCRIPTIONS_KEY } from "../src/events/subscriptions";
import { deleteCasesByProcess } from "../src/runtime";
import { deleteRole } from "../src/runtime/roles";
import { pgDeleteWorkflow } from "../src/storage/pg";
import { createWorkflow, validateWorkflowReadiness, type WorkflowDefinition } from "../src/workflow-loader";
import { makeWorkflowDefinition } from "./factories";
import { createTestRedis } from "./redis-test-utils";

const redis = createTestRedis();
const RUN = `binding-readiness-${Date.now()}`;
const touchedWorkflows = new Set<string>();
const touchedRoles = new Set<string>();

function workflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return makeWorkflowDefinition({
    id: overrides.id ?? `${RUN}-${Math.random().toString(16).slice(2)}`,
    name: "Binding readiness workflow",
    elements: [
      { id: "start", type: "event", label: "Start", trigger: { kind: "manual", manual_override: true } },
      { id: "task", type: "function", label: "Review", role: `${RUN}-operator` },
      { id: "done", type: "event", label: "Done", trigger: { kind: "manual", manual_override: true } },
    ],
    flow: [["start", "task"], ["task", "done"]],
    ...overrides,
  });
}

function codes(def: WorkflowDefinition, context: Parameters<typeof validateWorkflowReadiness>[1] = {}): string[] {
  return validateWorkflowReadiness(def, context).errors.map(error => error.code);
}

async function subscriptionCount(processId: string): Promise<number> {
  const raw = await redis.hgetall(SUBSCRIPTIONS_KEY).catch(() => ({} as Record<string, string>));
  return Object.values(raw).filter(value => {
    try {
      const sub = JSON.parse(value);
      return sub.process_id === processId && sub.status === "active";
    } catch {
      return false;
    }
  }).length;
}

async function deployedSnapshotKeys(processId: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [nextCursor, batch] = await redis.scan(cursor, "MATCH", `workflow:deployed:${processId}:*`, "COUNT", 100) as [string, string[]];
    keys.push(...batch);
    cursor = nextCursor;
  } while (cursor !== "0");
  return keys;
}

async function cleanupWorkflow(id: string): Promise<void> {
  await deleteCasesByProcess(id).catch(() => 0);
  const rawSubscriptions = await redis.hgetall(SUBSCRIPTIONS_KEY).catch(() => ({} as Record<string, string>));
  const subscriptionIds = Object.entries(rawSubscriptions)
    .filter(([, value]) => {
      try {
        return JSON.parse(value).process_id === id;
      } catch {
        return false;
      }
    })
    .map(([subscriptionId]) => subscriptionId);
  if (subscriptionIds.length > 0) await redis.hdel(SUBSCRIPTIONS_KEY, ...subscriptionIds);
  const snapshotKeys = await deployedSnapshotKeys(id);
  if (snapshotKeys.length > 0) await redis.del(...snapshotKeys);
  await redis.del(`workflow:${id}`);
  await redis.del(`konoha:workflow:versionctr:${id}`);
  await redis.srem("konoha:workflow:index", id);
  await pgDeleteWorkflow(id).catch(() => {});
}

afterAll(async () => {
  for (const id of touchedWorkflows) await cleanupWorkflow(id);
  for (const roleId of touchedRoles) await deleteRole(roleId).catch(() => {});
  redis.disconnect();
});

describe("workflow adapter and document binding readiness", () => {
  test("classifies missing and invalid adapter bindings with stable codes", () => {
    const missing = workflow({
      elements: [
        { id: "start", type: "event", label: "Start", trigger: { kind: "manual", manual_override: true } },
        { id: "task", type: "function", label: "Review", role: `${RUN}-operator`, systems: [{ connector: "missing-adapter", operation: "send" }] },
        { id: "done", type: "event", label: "Done", trigger: { kind: "manual", manual_override: true } },
      ],
    });
    const missingReceipt = validateWorkflowReadiness(missing, { adapters: ["telegram"] });
    expect(missingReceipt.errors).toContainEqual(expect.objectContaining({
      code: "ADAPTER_MISSING",
      class: "adapter",
      legacy_code: "RUNTIME_MISSING_ADAPTER",
    }));

    const invalid = workflow({
      elements: [
        { id: "start", type: "event", label: "Start", trigger: { kind: "manual", manual_override: true } },
        { id: "task", type: "function", label: "Review", role: `${RUN}-operator`, systems: [{ connector: "" } as any] },
        { id: "done", type: "event", label: "Done", trigger: { kind: "manual", manual_override: true } },
      ],
    });
    expect(codes(invalid, { adapters: ["telegram"] })).toContain("ADAPTER_BINDING_INVALID");
  });

  test("accepts registered adapter bindings", () => {
    const def = workflow({
      elements: [
        { id: "start", type: "event", label: "Start", trigger: { kind: "manual", manual_override: true } },
        { id: "task", type: "function", label: "Review", role: `${RUN}-operator`, systems: [{ connector: "telegram", operation: "send_message" }] },
        { id: "done", type: "event", label: "Done", trigger: { kind: "manual", manual_override: true } },
      ],
    });

    expect(codes(def, { adapters: ["telegram"] })).not.toContain("ADAPTER_MISSING");
  });

  test("classifies missing and invalid document bindings with stable codes", () => {
    const missing = workflow({
      elements: [
        { id: "start", type: "event", label: "Start", trigger: { kind: "manual", manual_override: true } },
        { id: "task", type: "function", label: "Review", role: `${RUN}-operator`, documents: ["missing.doc"] },
        { id: "done", type: "event", label: "Done", trigger: { kind: "manual", manual_override: true } },
      ],
    });
    const missingReceipt = validateWorkflowReadiness(missing, { documents: [] });
    expect(missingReceipt.errors).toContainEqual(expect.objectContaining({
      code: "DOCUMENT_MISSING",
      class: "document",
      legacy_code: "RUNTIME_MISSING_DOCUMENT",
    }));

    const invalid = workflow({
      elements: [
        { id: "start", type: "event", label: "Start", trigger: { kind: "manual", manual_override: true } },
        { id: "task", type: "function", label: "Review", role: `${RUN}-operator`, documents: [""] },
        { id: "done", type: "event", label: "Done", trigger: { kind: "manual", manual_override: true } },
      ],
    });
    expect(codes(invalid, { documents: [] })).toContain("DOCUMENT_BINDING_INVALID");
  });

  test("accepts seeded workflow documents as valid bindings", () => {
    const def = workflow({
      documents: [{ doc_id: "seeded.doc", name: "Seeded instruction", type: "instruction", content: "Use the seeded policy." }],
      elements: [
        { id: "start", type: "event", label: "Start", trigger: { kind: "manual", manual_override: true } },
        { id: "task", type: "function", label: "Review", role: `${RUN}-operator`, documents: ["seeded.doc"] },
        { id: "done", type: "event", label: "Done", trigger: { kind: "manual", manual_override: true } },
      ],
    });

    expect(codes(def, { documents: [] })).not.toContain("DOCUMENT_MISSING");
  });

  test("workflow.deploy blocks invalid bindings before subscriptions or deployed snapshots are materialized", async () => {
    const id = `${RUN}-deploy-blocked`;
    const roleId = `${RUN}-deploy-role`;
    touchedWorkflows.add(id);
    touchedRoles.add(roleId);

    const def = workflow({
      id,
      elements: [
        { id: "start", type: "event", label: "Start", trigger: { kind: "timer", cron: "*/5 * * * *", confidence: 1 } },
        {
          id: "task",
          type: "function",
          label: "Review",
          role: roleId,
          documents: ["missing.doc"],
          systems: [{ connector: "missing-adapter", operation: "send" }],
        },
        { id: "done", type: "event", label: "Done", trigger: { kind: "manual", manual_override: true } },
      ],
    });
    await createWorkflow(def);

    const deployed = await executeActionDirect("workflow.deploy", { id, deployed_by: "operator-1" });

    expect(deployed?.status).toBe(422);
    expect((deployed?.data as any)).toMatchObject({
      code: "WORKFLOW_VALIDATION_BLOCKED",
      process_id: id,
      validation: { readiness: "blocked" },
    });
    const errors = (deployed?.data as any).validation.errors;
    expect(errors).toContainEqual(expect.objectContaining({ code: "ADAPTER_MISSING", class: "adapter" }));
    expect(errors).toContainEqual(expect.objectContaining({ code: "DOCUMENT_MISSING", class: "document" }));
    expect(await subscriptionCount(id)).toBe(0);
    expect(await deployedSnapshotKeys(id)).toEqual([]);
  });
});
