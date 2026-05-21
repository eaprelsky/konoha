import { afterAll, describe, expect, test } from "bun:test";
import { createTestRedis } from "./redis-test-utils";
import { executeAction } from "../src/act-envelope";
import { executeActionDirect } from "../src/action-executor";
import { deleteCasesByProcess } from "../src/runtime";
import { createRole, deleteRole, updateRole } from "../src/runtime/roles";
import { createWorkflow } from "../src/workflow-loader";
import { pgDeleteWorkflow } from "../src/storage/pg";
import type { WorkflowDefinition } from "../src/workflow-loader";

const redis = createTestRedis();
const RUN = `lifecycle-${Date.now()}`;
const touched = new Set<string>();
const touchedRoles = new Set<string>();

function workflow(id: string, role = "reviewer"): WorkflowDefinition {
  return {
    id,
    version: "1.0.0",
    name: `Lifecycle ${id}`,
    elements: [
      { id: "start", type: "event", label: "Start", trigger: { kind: "manual", manual_override: true } },
      { id: "task", type: "function", label: "Review", role },
      { id: "done", type: "event", label: "Done", trigger: { kind: "manual", manual_override: true } },
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
  for (const id of touchedRoles) await deleteRole(id).catch(() => {});
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

  test("workflow.validate returns structured readiness errors and deploy refuses blockers", async () => {
    const id = `${RUN}-validate-blocked`;
    const roleId = `${RUN}-blocked-role`;
    touched.add(id);
    touchedRoles.add(roleId);
    await createWorkflow(workflow(id, roleId));
    await createRole({
      role_id: roleId,
      name: "Blocked role",
      assignees: [],
      strategy: "round-robin",
      required_capabilities: [],
    });

    const validation = await executeActionDirect("workflow.validate", { id });
    expect(validation?.status).toBe(200);
    expect((validation?.data as any).readiness).toBe("blocked");
    expect((validation?.data as any).errors.map((error: any) => error.code)).toContain("RUNTIME_MISSING_ROLE_ASSIGNEE");

    const deploy = await executeActionDirect("workflow.deploy", { id });
    expect(deploy?.status).toBe(422);
    expect((deploy?.data as any)).toMatchObject({
      code: "WORKFLOW_VALIDATION_BLOCKED",
      process_id: id,
      validation: { readiness: "blocked" },
    });
  });

  test("workflow.update surfaces canonical validation receipt on blocking edits", async () => {
    const id = `${RUN}-update-receipt`;
    touched.add(id);
    await createWorkflow(workflow(id));

    const updated = await executeActionDirect("workflow.update", {
      id,
      elements: [
        { id: "task", type: "function", label: "Review", role: "reviewer" },
        { id: "done", type: "event", label: "Done" },
      ],
      flow: [["task", "done"]],
      draft: false,
    });

    expect(updated?.status).toBe(422);
    expect((updated?.data as any)).toMatchObject({
      code: "WORKFLOW_VALIDATION_BLOCKED",
      workflow_id: id,
      validation: { readiness: "blocked" },
    });
    expect((updated?.data as any).validation.errors.map((error: any) => error.code)).toContain("GRAPH_NO_START_EVENT");
  });

  test("workflow.create surfaces canonical validation receipt on blocking definitions", async () => {
    const id = `${RUN}-create-receipt`;
    touched.add(id);

    const created = await executeActionDirect("workflow.create", {
      id,
      name: "Invalid create receipt",
      elements: [
        { id: "task", type: "function", label: "Review", role: "reviewer" },
        { id: "done", type: "event", label: "Done" },
      ],
      flow: [["task", "done"]],
      draft: false,
    });

    expect(created?.status).toBe(422);
    expect((created?.data as any)).toMatchObject({
      code: "WORKFLOW_VALIDATION_BLOCKED",
      validation: { readiness: "blocked" },
    });
    expect((created?.data as any).validation.errors.map((error: any) => error.code)).toContain("GRAPH_NO_START_EVENT");
  });

  test("case.start rechecks readiness for executable workflows", async () => {
    const id = `${RUN}-start-readiness`;
    const roleId = `${RUN}-start-role`;
    touched.add(id);
    touchedRoles.add(roleId);
    await createRole({
      role_id: roleId,
      name: "Start role",
      assignees: ["operator-1"],
      strategy: "round-robin",
      required_capabilities: [],
    });
    await createWorkflow(workflow(id, roleId));
    const deploy = await executeActionDirect("workflow.deploy", { id });
    expect(deploy?.status).toBe(200);

    await updateRole(roleId, { assignees: [] });
    const blocked = await executeActionDirect("case.start", {
      process_id: id,
      subject: "Blocked by readiness",
      payload: {},
    });

    expect(blocked?.status).toBe(409);
    expect((blocked?.data as any)).toMatchObject({
      code: "WORKFLOW_READINESS_BLOCKED",
      process_id: id,
      validation: { readiness: "blocked" },
    });
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
