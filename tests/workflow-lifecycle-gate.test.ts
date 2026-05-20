import { afterAll, describe, expect, test } from "bun:test";
import { createTestRedis } from "./redis-test-utils";
import { executeAction } from "../src/act-envelope";
import { executeActionDirect } from "../src/action-executor";
import { deleteCasesByProcess } from "../src/runtime";
import { createWorkflow } from "../src/workflow-loader";
import { pgDeleteWorkflow } from "../src/storage/pg";
import type { WorkflowDefinition } from "../src/workflow-loader";

const redis = createTestRedis();
const RUN = `lifecycle-${Date.now()}`;
const touched = new Set<string>();

function workflow(id: string): WorkflowDefinition {
  return {
    id,
    version: "1.0.0",
    name: `Lifecycle ${id}`,
    elements: [
      { id: "start", type: "event", label: "Start", trigger: { kind: "manual", manual_override: true } },
      { id: "task", type: "function", label: "Review", role: "reviewer" },
      { id: "done", type: "event", label: "Done" },
    ],
    flow: [["start", "task"], ["task", "done"]],
  };
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
});

describe("workflow lifecycle deploy gate", () => {
  test("workflow.create stores validated state but does not make the workflow executable", async () => {
    const id = `${RUN}-validated`;
    touched.add(id);

    const created = await executeActionDirect("workflow.create", { ...workflow(id), draft: false });
    expect(created?.status).toBe(201);
    expect((created?.data as any).lifecycle_state).toBe("validated");
    expect((created?.data as any).last_validation).toMatchObject({ status: "passed", source: "workflow.create" });
    expect((created?.data as any).last_deploy).toBeUndefined();

    const blocked = await executeActionDirect("case.start", {
      process_id: id,
      subject: "Blocked draft/validated run",
      payload: {},
    });
    expect(blocked?.status).toBe(409);
    expect(blocked?.data).toMatchObject({
      code: "WORKFLOW_NOT_EXECUTABLE",
      process_id: id,
      lifecycle_state: "validated",
      required_lifecycle_state: "executable",
    });
  });

  test("workflow.deploy marks a validated workflow executable and case.start succeeds", async () => {
    const id = `${RUN}-deploy`;
    touched.add(id);
    await createWorkflow(workflow(id));

    const deployed = await executeActionDirect("workflow.deploy", { id });
    expect(deployed?.status).toBe(200);
    expect((deployed?.data as any).lifecycle_state).toBe("executable");
    expect((deployed?.data as any).last_deploy).toMatchObject({ status: "succeeded", source: "workflow.deploy" });

    const started = await executeActionDirect("case.start", {
      process_id: id,
      subject: "Executable run",
      payload: {},
    });
    expect(started?.status).toBe(201);
    expect((started?.data as any).process_id).toBe(id);
  });

  test("workflow.update demotes executable workflows back to validated until redeploy", async () => {
    const id = `${RUN}-demote`;
    touched.add(id);
    await createWorkflow(workflow(id));
    await executeActionDirect("workflow.deploy", { id });

    const updated = await executeActionDirect("workflow.update", {
      id,
      name: "Lifecycle demoted after edit",
      draft: false,
    });
    expect(updated?.status).toBe(200);
    expect((updated?.data as any).lifecycle_state).toBe("validated");
    expect((updated?.data as any).last_deploy).toBeUndefined();

    const blocked = await executeActionDirect("case.start", {
      process_id: id,
      subject: "Blocked after edit",
      payload: {},
    });
    expect(blocked?.status).toBe(409);
    expect((blocked?.data as any).code).toBe("WORKFLOW_NOT_EXECUTABLE");
  });

  test("case.start supports explicit admin override for tests and migration", async () => {
    const id = `${RUN}-override`;
    touched.add(id);
    await createWorkflow(workflow(id), { draft: true });

    const started = await executeActionDirect("case.start", {
      process_id: id,
      subject: "Override run",
      payload: {},
      admin_override: true,
    });
    expect(started?.status).toBe(201);
    expect((started?.data as any).process_id).toBe(id);
  });

  test("action envelope preserves structured non-executable case.start rejection", async () => {
    const id = `${RUN}-act-structured`;
    touched.add(id);
    await createWorkflow(workflow(id));

    const result = await executeAction({
      action: "case.start",
      category: "act",
      args: {
        process_id: id,
        subject: "Envelope blocked run",
        payload: {},
      },
    }, { skipAutonomy: true });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(409);
    expect(result.error).toBe("Workflow is not executable");
    expect(result.data).toMatchObject({
      code: "WORKFLOW_NOT_EXECUTABLE",
      process_id: id,
      lifecycle_state: "validated",
      required_lifecycle_state: "executable",
    });
  });
});
