import { afterAll, describe, expect, test } from "bun:test";
import { createTestRedis } from "./redis-test-utils";
import { executeActionDirect } from "../src/action-executor";
import { createRole, deleteRole } from "../src/runtime/roles";
import { getWorkflow, getWorkflowDeployedSnapshot } from "../src/workflow-loader";
import { pgDeleteWorkflow } from "../src/storage/pg";

const redis = createTestRedis();
const RUN = `workflow-patch-${Date.now()}`;
const ROLE_ID = `${RUN}-manual-role`;

async function cleanupWorkflow(id: string) {
  await redis.srem("konoha:workflow:index", id);
  await redis.del(`workflow:${id}`);
  await pgDeleteWorkflow(id).catch(() => {});
}

async function createDraftWorkflow(id: string) {
  const created = await executeActionDirect("workflow.create", {
    id,
    name: "Patch target",
    elements: [],
    flow: [],
    draft: true,
  });
  expect(created?.status).toBe(201);
}

afterAll(async () => {
  const ids = await redis.smembers("konoha:workflow:index");
  for (const id of ids) {
    if (id.startsWith(RUN)) await cleanupWorkflow(id);
  }
  await deleteRole(ROLE_ID).catch(() => {});
  redis.disconnect();
});

describe("atomic workflow patch service", () => {
  test("applies element, flow, and trigger edits as one validated patch", async () => {
    const id = `${RUN}-success`;
    await createDraftWorkflow(id);
    await createRole({ role_id: ROLE_ID, name: "Patch role", strategy: "manual", assignees: [] });

    const result = await executeActionDirect("workflow.patch", {
      id,
      idempotency_key: "first-apply",
      patch: {
        set_name: "Patched workflow",
        add_elements: [
          { id: "start", type: "event", label: "Start" },
          { id: "review", type: "function", label: "Review", role: ROLE_ID },
          { id: "done", type: "event", label: "Done" },
        ],
        add_flow: [["start", "review"], ["review", "done"]],
        set_triggers: [
          { element_id: "start", trigger: { kind: "manual", manual_override: true } },
        ],
      },
    });

    expect(result?.status).toBe(200);
    const body = result!.data as any;
    expect(body.ok).toBe(true);
    expect(body.action).toBe("workflow.patch");
    expect(body.workflow_id).toBe(id);
    expect(body.idempotency_key).toBe("first-apply");
    expect(body.validation.source).toBe("workflow.patch");
    expect(body.validation.readiness).toBe("ready");
    expect(body.changed_resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "element", id: "start", change: "created" }),
      expect.objectContaining({ kind: "flow", id: "start:review", change: "created" }),
      expect.objectContaining({ kind: "trigger", id: "start", change: "updated" }),
    ]));

    const saved = await getWorkflow(id);
    expect(saved?.name).toBe("Patched workflow");
    expect(saved?.elements.map(element => element.id).sort()).toEqual(["done", "review", "start"]);
    expect(saved?.flow).toEqual([["start", "review"], ["review", "done"]]);
    expect(saved?.last_validation?.source).toBe("workflow.patch");
  });

  test("rejects invalid patches without partially persisting added resources", async () => {
    const id = `${RUN}-rollback`;
    await createDraftWorkflow(id);

    const result = await executeActionDirect("workflow.patch", {
      id,
      patch: {
        add_elements: [
          { id: "start", type: "event", label: "Start", trigger: { kind: "manual", manual_override: true } },
          { id: "done", type: "event", label: "Done" },
          { id: "orphan", type: "event", label: "Orphan" },
        ],
        add_flow: [["start", "done"], ["orphan", "missing"]],
      },
    });

    expect(result?.status).toBe(422);
    const body = result!.data as any;
    expect(body.ok).toBe(false);
    expect(body.code).toBe("WORKFLOW_PATCH_VALIDATION_FAILED");
    expect(body.validation.source).toBe("workflow.patch");
    expect(body.validation.errors.some((error: any) => error.code === "GRAPH_INVALID_EDGE_ENDPOINT")).toBe(true);

    const saved = await getWorkflow(id);
    expect(saved?.elements).toEqual([]);
    expect(saved?.flow).toEqual([]);
  });

  test("detects expected deploy-version conflicts before mutation", async () => {
    const id = `${RUN}-version-conflict`;
    await createDraftWorkflow(id);

    const result = await executeActionDirect("workflow.patch", {
      id,
      expected_deploy_version: 99,
      patch: {
        set_name: "Should not persist",
      },
    });

    expect(result?.status).toBe(409);
    const body = result!.data as any;
    expect(body.ok).toBe(false);
    expect(body.code).toBe("WORKFLOW_PATCH_CONFLICT");

    const saved = await getWorkflow(id);
    expect(saved?.name).toBe("Patch target");
  });

  test("patching an executable workflow does not mutate deployed runtime snapshots", async () => {
    const id = `${RUN}-snapshot-isolation`;
    await createRole({ role_id: ROLE_ID, name: "Patch role", strategy: "manual", assignees: [] });

    const created = await executeActionDirect("workflow.create", {
      id,
      name: "Executable before patch",
      elements: [
        { id: "start", type: "event", label: "Start", trigger: { kind: "manual", manual_override: true } },
        { id: "review", type: "function", label: "Review", role: ROLE_ID },
        { id: "done", type: "event", label: "Done", trigger: { manual_override: true } },
      ],
      flow: [["start", "review"], ["review", "done"]],
    });
    expect(created?.status).toBe(201);

    const deployed = await executeActionDirect("workflow.deploy", { id, deployed_by: "workflow-patch-test" });
    expect(deployed?.status).toBe(200);
    const beforePatch = await getWorkflow(id);
    expect(beforePatch?.lifecycle_state).toBe("executable");
    expect(beforePatch?.deploy_version).toBe(1);

    const patched = await executeActionDirect("workflow.patch", {
      id,
      expected_deploy_version: 1,
      patch: { set_name: "Editable patched definition" },
    });
    expect(patched?.status).toBe(200);

    const current = await getWorkflow(id);
    expect(current?.name).toBe("Editable patched definition");
    expect(current?.lifecycle_state).toBe("validated");

    const snapshot = await getWorkflowDeployedSnapshot({
      workflow_id: id,
      deploy_version: 1,
      snapshot_key: `workflow:deployed:${id}:v1`,
      bound_at: new Date().toISOString(),
      source: "test",
    });
    expect(snapshot?.name).toBe("Executable before patch");
    expect(snapshot?.lifecycle_state).toBe("executable");
  });
});
