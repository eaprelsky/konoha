import { afterAll, describe, expect, test } from "bun:test";
import { createTestRedis } from "./redis-test-utils";
import { executeAction } from "../src/act-envelope";
import { executeActionDirect } from "../src/action-executor";
import { deleteCasesByProcess } from "../src/runtime";
import { createRole, deleteRole, updateRole } from "../src/runtime/roles";
import { createWorkflow, getWorkflow, listWorkflows } from "../src/workflow-loader";
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

  test("workflow.deploy persists lifecycle schema version, deploy version, and deployed_by", async () => {
    const id = `${RUN}-deploy-metadata`;
    touched.add(id);
    await createWorkflow(workflow(id));

    const firstDeploy = await executeActionDirect("workflow.deploy", { id, deployed_by: "operator-1" });
    expect(firstDeploy?.status).toBe(200);
    expect((firstDeploy?.data as any)).toMatchObject({
      status: "executable",
      lifecycle_state: "executable",
      validation_status: "passed",
      deploy_version: 1,
      deployed_by: "operator-1",
      lifecycle: {
        schema_version: 1,
        state: "executable",
        status: "executable",
        validation_status: "passed",
        deploy_version: 1,
        deployed_by: "operator-1",
      },
      last_deploy: {
        status: "succeeded",
        deploy_version: 1,
        deployed_by: "operator-1",
        source: "workflow.deploy",
      },
    });
    expect(typeof (firstDeploy?.data as any).deployed_at).toBe("string");

    const secondDeploy = await executeActionDirect("workflow.deploy", { id, deployed_by: "operator-2" });
    expect(secondDeploy?.status).toBe(200);
    expect((secondDeploy?.data as any)).toMatchObject({
      deploy_version: 2,
      deployed_by: "operator-2",
      lifecycle: { deploy_version: 2, deployed_by: "operator-2" },
      last_deploy: { deploy_version: 2, deployed_by: "operator-2" },
    });
  });

  test("legacy workflow records are backfilled to canonical lifecycle schema on read", async () => {
    const id = `${RUN}-legacy-active`;
    touched.add(id);
    await redis.set(`workflow:${id}`, JSON.stringify({
      id,
      version: "0.9.0",
      name: "Legacy active workflow",
      status: "active",
      elements: [
        { id: "start", type: "event", label: "Start", trigger: { kind: "manual", manual_override: true } },
        { id: "task", type: "function", label: "Review", role: "reviewer" },
        { id: "done", type: "event", label: "Done", trigger: { kind: "manual", manual_override: true } },
      ],
      flow: [["start", "task"], ["task", "done"]],
      last_validation: { status: "passed", checked_at: "2026-05-01T00:00:00.000Z", error_count: 0, source: "legacy" },
      last_deploy: { status: "succeeded", checked_at: "2026-05-01T00:00:00.000Z", deployed_at: "2026-05-01T00:00:01.000Z", source: "legacy" },
    }));
    await redis.sadd("konoha:workflow:index", id);

    const loaded = await getWorkflow(id);
    expect(loaded).toMatchObject({
      status: "executable",
      lifecycle_state: "executable",
      validation_status: "passed",
      deploy_version: 1,
      deployed_at: "2026-05-01T00:00:01.000Z",
      lifecycle: {
        schema_version: 1,
        state: "executable",
        status: "executable",
        validation_status: "passed",
        deploy_version: 1,
        migrated_from_status: "active",
      },
    });
    expect(typeof loaded?.lifecycle?.backfilled_at).toBe("string");
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
    expect((validation?.data as any).errors).toContainEqual(expect.objectContaining({
      code: "ROLE_MISSING_ASSIGNEE",
      legacy_code: "RUNTIME_MISSING_ROLE_ASSIGNEE",
      class: "role",
    }));

    const deploy = await executeActionDirect("workflow.deploy", { id });
    expect(deploy?.status).toBe(422);
    expect((deploy?.data as any)).toMatchObject({
      code: "WORKFLOW_VALIDATION_BLOCKED",
      process_id: id,
      validation: { readiness: "blocked" },
    });
  });

  test("workflow.deploy trigger review path returns canonical validation receipt", async () => {
    const id = `${RUN}-trigger-review`;
    touched.add(id);
    await createWorkflow({
      ...workflow(id),
      elements: [
        { id: "start", type: "event", label: "Unresolved start" },
        { id: "task", type: "function", label: "Review", role: "reviewer" },
        { id: "done", type: "event", label: "Done", trigger: { kind: "manual", manual_override: true } },
      ],
    });

    const oldAnthropicKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const deploy = await executeActionDirect("workflow.deploy", { id });

      expect(deploy?.status).toBe(409);
      expect((deploy?.data as any)).toMatchObject({
        code: "WORKFLOW_DEPLOY_NEEDS_REVIEW",
        process_id: id,
        validation: {
          readiness: "blocked",
          source: "workflow.deploy",
          gates: {
            deployment_blocker: true,
            release_blocker: true,
          },
        },
      });
      expect((deploy?.data as any).validation.errors).toContainEqual(expect.objectContaining({
        code: "TRIGGER_AMBIGUOUS",
        legacy_code: "DEPLOYMENT_AMBIGUOUS_TRIGGER",
        class: "trigger",
      }));
      expect((deploy?.data as any).workflow.last_deploy.details).toContain("TRIGGER_AMBIGUOUS: Event \"start\" trigger is ambiguous and requires manual override");
    } finally {
      if (oldAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = oldAnthropicKey;
    }
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

  test("workflow.delete retires workflows with durable lifecycle metadata", async () => {
    const id = `${RUN}-retired`;
    touched.add(id);
    await createWorkflow(workflow(id));
    await executeActionDirect("workflow.deploy", { id, deployed_by: "operator-1" });

    const deleted = await executeActionDirect("workflow.delete", { id });
    expect(deleted?.status).toBe(200);
    expect((deleted?.data as any)).toMatchObject({ ok: true, archived: true, workflow_id: id });

    const retired = await getWorkflow(id);
    expect(retired).toMatchObject({
      status: "retired",
      lifecycle_state: "retired",
      retired_by: "workflow.delete",
      lifecycle: {
        schema_version: 1,
        state: "retired",
        status: "retired",
        retired_by: "workflow.delete",
      },
      last_deploy: {
        status: "retired",
        source: "workflow.delete",
      },
    });
    expect(typeof retired?.retired_at).toBe("string");

    const listed = await listWorkflows();
    expect(listed.map(workflow => workflow.id)).not.toContain(id);

    const blocked = await executeActionDirect("case.start", {
      process_id: id,
      subject: "Retired workflow run",
      payload: {},
    });
    expect(blocked?.status).toBe(409);
    expect((blocked?.data as any)).toMatchObject({
      code: "WORKFLOW_NOT_EXECUTABLE",
      lifecycle_state: "retired",
    });
  });

  test("workflow.retire is the canonical retire action and remains idempotent", async () => {
    const id = `${RUN}-canonical-retire`;
    touched.add(id);
    await createWorkflow(workflow(id));
    await executeActionDirect("workflow.deploy", { id, deployed_by: "operator-1" });

    const retired = await executeActionDirect("workflow.retire", {
      id,
      mode: "retire_only",
      retired_by: "operator-2",
    });
    expect(retired?.status).toBe(200);
    expect((retired?.data as any)).toMatchObject({
      ok: true,
      action: "workflow.retire",
      archived: true,
      retired: true,
      workflow_id: id,
      mode: "retire_only",
      lifecycle_state: "retired",
      retired_by: "operator-2",
      already_retired: false,
      deleted_cases: 0,
      deleted_work_items: 0,
      cancelled_subscriptions: 0,
    });

    const stored = await getWorkflow(id);
    expect(stored).toMatchObject({
      status: "retired",
      lifecycle_state: "retired",
      retired_by: "operator-2",
      lifecycle: {
        schema_version: 1,
        state: "retired",
        retired_by: "operator-2",
      },
      last_deploy: {
        status: "retired",
        source: "workflow.retire",
      },
    });

    const second = await executeActionDirect("workflow.retire", { id, retired_by: "operator-3" });
    expect(second?.status).toBe(200);
    expect((second?.data as any)).toMatchObject({
      ok: true,
      action: "workflow.retire",
      workflow_id: id,
      lifecycle_state: "retired",
      retired_by: "operator-2",
      already_retired: true,
    });

    const redeploy = await executeActionDirect("workflow.deploy", { id });
    expect(redeploy?.status).toBe(409);
    expect((redeploy?.data as any)).toMatchObject({
      error: "Workflow is retired",
      code: "WORKFLOW_RETIRED",
      process_id: id,
      lifecycle_state: "retired",
    });
  });

  test("workflow.deploy and workflow.retire return stable not-found and mode errors", async () => {
    const missingId = `${RUN}-missing`;
    const missingDeploy = await executeActionDirect("workflow.deploy", { id: missingId });
    expect(missingDeploy?.status).toBe(404);
    expect((missingDeploy?.data as any)).toMatchObject({
      error: "Workflow not found",
      code: "WORKFLOW_NOT_FOUND",
      workflow_id: missingId,
    });

    const missingRetire = await executeActionDirect("workflow.retire", { id: missingId });
    expect(missingRetire?.status).toBe(404);
    expect((missingRetire?.data as any)).toMatchObject({
      error: "Workflow not found",
      code: "WORKFLOW_NOT_FOUND",
      workflow_id: missingId,
    });

    const invalidModeId = `${RUN}-invalid-retire-mode`;
    touched.add(invalidModeId);
    await createWorkflow(workflow(invalidModeId));
    const invalidMode = await executeActionDirect("workflow.retire", { id: invalidModeId, mode: "erase_everything" });
    expect(invalidMode?.status).toBe(400);
    expect((invalidMode?.data as any)).toMatchObject({
      error: "Invalid workflow retire mode",
      code: "WORKFLOW_RETIRE_INVALID_MODE",
      workflow_id: invalidModeId,
    });
    expect((invalidMode?.data as any).allowed_modes).toContain("retire_only");
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
