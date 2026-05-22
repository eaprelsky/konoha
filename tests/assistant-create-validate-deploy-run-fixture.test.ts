import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { invokeAssistant } from "../src/assistant-invocation";
import { AUTONOMY_KEY } from "../src/assistant-actions";
import { executeActionDirect } from "../src/action-executor";
import { cancelSubscriptionsByProcessAndInstance } from "../src/event-manager";
import { deleteCasesByProcess } from "../src/runtime";
import { deleteRole } from "../src/runtime/roles";
import { pgDeleteWorkflow } from "../src/storage/pg";
import {
  WORKFLOW_DEPLOY_RECORD_GLOBAL_INDEX,
  workflowDeploymentRecordIndexKey,
} from "../src/workflow-deployment-service";
import { getWorkflow, WORKFLOW_INDEX_KEY, type WorkflowDefinition } from "../src/workflow-loader";
import { createTestRedis } from "./redis-test-utils";

const redis = createTestRedis();
const RUN = `assistant-golden-${Date.now()}`;
const touchedWorkflows = new Set<string>();
const touchedRoles = new Set<string>();
const savedAutonomy: Record<string, string | null> = {};

function workflowDefinition(id: string, roleId: string, draftReady = true): WorkflowDefinition {
  return {
    id,
    version: "1.0.0",
    name: `Assistant golden ${id}`,
    elements: [
      { id: "start", type: "event", label: "Start", trigger: { kind: "manual", manual_override: true } },
      { id: "review", type: "function", label: "Review request", role: roleId },
      { id: "done", type: "event", label: "Done", trigger: { kind: "manual", manual_override: true } },
    ],
    flow: [["start", "review"], ["review", "done"]],
    ...(draftReady ? {} : { description: "Intentionally missing role readiness for negative fixture." }),
  };
}

function assistantFixtureResponse(steps: Array<Record<string, unknown>>): string {
  return JSON.stringify({
    reply: "Executing deterministic create-validate-deploy-run fixture.",
    action_sequence: steps,
  });
}

async function cleanupWorkflow(id: string): Promise<void> {
  await deleteCasesByProcess(id).catch(() => 0);
  await cancelSubscriptionsByProcessAndInstance(id, "new").catch(() => 0);
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [nextCursor, batch] = await redis.scan(
      cursor,
      "MATCH",
      `workflow:*:${id}:*`,
      "COUNT",
      100,
    ) as [string, string[]];
    keys.push(...batch);
    cursor = nextCursor;
  } while (cursor !== "0");
  if (keys.length > 0) {
    await redis.del(...keys);
    await redis.zrem(WORKFLOW_DEPLOY_RECORD_GLOBAL_INDEX, ...keys).catch(() => 0);
  }
  await redis.del(workflowDeploymentRecordIndexKey(id));
  await redis.del(`workflow:${id}`);
  await redis.del(`konoha:workflow:versionctr:${id}`);
  await redis.srem(WORKFLOW_INDEX_KEY, id);
  await pgDeleteWorkflow(id).catch(() => {});
}

beforeAll(async () => {
  for (const action of ["role.create", "workflow.create", "workflow.validate", "workflow.deploy"]) {
    savedAutonomy[action] = await redis.hget(AUTONOMY_KEY, action);
    await redis.hset(AUTONOMY_KEY, action, "auto");
  }
});

afterAll(async () => {
  for (const [action, value] of Object.entries(savedAutonomy)) {
    if (value == null) await redis.hdel(AUTONOMY_KEY, action);
    else await redis.hset(AUTONOMY_KEY, action, value);
  }
  for (const id of touchedWorkflows) await cleanupWorkflow(id);
  for (const roleId of touchedRoles) await deleteRole(roleId).catch(() => {});
  redis.disconnect();
});

describe("deterministic assistant create-validate-deploy-run fixture", () => {
  test("runs the golden path through assistant.invoke and Action Spine without a live LLM", async () => {
    const workflowId = `${RUN}-success`;
    const roleId = `${workflowId}-reviewer`;
    touchedWorkflows.add(workflowId);
    touchedRoles.add(roleId);
    const workflow = workflowDefinition(workflowId, roleId);

    const result = await invokeAssistant({
      assistant_id: "tsunade",
      message: "Create, validate, deploy, and run the fixture process.",
      conversation_id: `${workflowId}-conversation`,
      persist_history: false,
      fixture_response: assistantFixtureResponse([
        { action: "role.create", args: { role_id: roleId, name: "Fixture reviewer", assignees: [], strategy: "manual" } },
        { action: "workflow.create", args: { ...workflow, draft: false } },
        { action: "workflow.validate", args: { id: workflowId } },
        { action: "workflow.deploy", args: { id: workflowId, deployed_by: "assistant-fixture", idempotency_key: `${workflowId}:deploy` } },
        { action: "case.start", args: { process_id: workflowId, subject: "Assistant fixture run", payload: { source: "assistant-fixture" } } },
      ]),
    });

    const normalized = result.normalized_response as any;
    expect(result.ok).toBe(true);
    expect(normalized.actions_taken.map((action: any) => [action.action, action.status])).toEqual([
      ["role.create", "executed"],
      ["workflow.create", "executed"],
      ["workflow.validate", "executed"],
      ["workflow.deploy", "executed"],
      ["case.start", "executed"],
    ]);
    expect(normalized.action_receipts.map((receipt: any) => [receipt.action, receipt.status])).toEqual([
      ["role.create", "succeeded"],
      ["workflow.create", "succeeded"],
      ["workflow.validate", "succeeded"],
      ["workflow.deploy", "succeeded"],
      ["case.start", "succeeded"],
    ]);
    expect(normalized.observable_result.status).toBe("succeeded");
    expect(normalized.ui_actions.some((action: any) => action.type === "navigate" && String(action.path).startsWith("/monitor?case_id="))).toBe(true);

    const savedWorkflow = await getWorkflow(workflowId);
    expect(savedWorkflow).toMatchObject({
      id: workflowId,
      lifecycle_state: "executable",
      deploy_version: 1,
    });

    const startAction = normalized.actions_taken.find((action: any) => action.action === "case.start");
    expect(startAction.result.next_work_item).toMatchObject({
      process_id: workflowId,
      element_id: "review",
      label: "Review request",
      assignee: roleId,
      status: "pending",
    });
  });

  test("stops before runtime when deploy readiness fails", async () => {
    const workflowId = `${RUN}-blocked`;
    const missingRole = `${workflowId}-missing-role`;
    touchedWorkflows.add(workflowId);
    const workflow = workflowDefinition(workflowId, missingRole, false);

    const result = await invokeAssistant({
      assistant_id: "tsunade",
      message: "Run the negative fixture.",
      conversation_id: `${workflowId}-conversation`,
      persist_history: false,
      fixture_response: assistantFixtureResponse([
        { action: "workflow.create", args: { ...workflow, draft: true } },
        { action: "workflow.validate", args: { id: workflowId } },
        { action: "workflow.deploy", args: { id: workflowId, deployed_by: "assistant-fixture" } },
        { action: "case.start", args: { process_id: workflowId, subject: "Should not run", payload: {} } },
      ]),
    });

    const normalized = result.normalized_response as any;
    expect(normalized.actions_taken.map((action: any) => [action.action, action.status])).toEqual([
      ["workflow.create", "executed"],
      ["workflow.validate", "executed"],
      ["workflow.deploy", "failed"],
      ["case.start", "skipped"],
    ]);
    expect(normalized.action_receipts).toContainEqual(expect.objectContaining({
      action: "workflow.deploy",
      status: "failed",
    }));
    expect(normalized.observable_result.status).toBe("partial");

    const cases = await executeActionDirect("case.list", { process_id: workflowId });
    expect(cases?.status).toBe(200);
    expect((cases?.data as any).cases ?? (cases?.data as any).items ?? cases?.data).toEqual([]);
    const savedWorkflow = await getWorkflow(workflowId);
    expect(savedWorkflow?.lifecycle_state).not.toBe("executable");
  });
});
