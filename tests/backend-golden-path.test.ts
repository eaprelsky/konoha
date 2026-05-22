import { afterAll, describe, expect, test } from "bun:test";
import { executeAction } from "../src/act-envelope";
import { classifyAction } from "../src/action-registry";
import { cancelSubscriptionsByProcessAndInstance } from "../src/event-manager";
import { deleteCasesByProcess } from "../src/runtime";
import { deleteRole } from "../src/runtime/roles";
import { listWorkItems } from "../src/runtime/work-items";
import {
  handleWorkItemDispatchEffect,
  workItemDispatchIdempotencyKey,
} from "../src/runtime/workitem-dispatch-outbox";
import {
  getRuntimeEffect,
  runtimeEffectIdFromIdempotencyKey,
  runtimeEffectStorageKeys,
  type RuntimeEffectRecord,
} from "../src/runtime-effect-outbox";
import { pgDeleteWorkflow } from "../src/storage/pg";
import {
  getWorkflowDeploymentRecord,
  WORKFLOW_DEPLOY_RECORD_GLOBAL_INDEX,
  workflowDeploymentRecordIndexKey,
} from "../src/workflow-deployment-service";
import {
  getWorkflow,
  WORKFLOW_INDEX_KEY,
  type WorkflowDefinition,
} from "../src/workflow-loader";
import { createTestRedis } from "./redis-test-utils";

const redis = createTestRedis();
const RUN = `backend-golden-${Date.now()}`;
const touchedWorkflows = new Set<string>();
const touchedRoles = new Set<string>();
const touchedEffects = new Map<string, RuntimeEffectRecord>();

function workflowDefinition(id: string, roleId: string): WorkflowDefinition {
  return {
    id,
    version: "1.0.0",
    name: `Backend golden ${id}`,
    elements: [
      { id: "start", type: "event", label: "Start", trigger: { kind: "manual", manual_override: true } },
      { id: "review", type: "function", label: "Review request", role: roleId },
      { id: "done", type: "event", label: "Done", trigger: { kind: "manual", manual_override: true } },
    ],
    flow: [["start", "review"], ["review", "done"]],
  };
}

async function act(action: string, args: Record<string, unknown>) {
  return executeAction({
    action,
    category: classifyAction(action),
    args,
    meta: {
      session_id: `${RUN}-session`,
      agent_chain: "backend-golden-path",
    },
  }, {
    skipAutonomy: true,
    session_id: `${RUN}-session`,
    agent_chain: "backend-golden-path",
  });
}

async function cleanupRuntimeEffect(record: RuntimeEffectRecord): Promise<void> {
  const keys = runtimeEffectStorageKeys(record);
  const pipe = redis.pipeline();
  pipe.del(keys.record_key);
  pipe.del(keys.idempotency_key);
  pipe.zrem(keys.status_index_key, record.effect_id);
  if (keys.case_index_key) pipe.zrem(keys.case_index_key, record.effect_id);
  if (keys.work_item_index_key) pipe.zrem(keys.work_item_index_key, record.effect_id);
  if (keys.deploy_record_index_key) pipe.zrem(keys.deploy_record_index_key, record.effect_id);
  if (keys.subscription_index_key) pipe.zrem(keys.subscription_index_key, record.effect_id);
  pipe.del(`runtime:effect:lock:${record.effect_id}`);
  pipe.del(`workitem:dispatch:delivered:${record.effect_id}`);
  await pipe.exec();
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

afterAll(async () => {
  for (const record of touchedEffects.values()) await cleanupRuntimeEffect(record).catch(() => {});
  for (const id of touchedWorkflows) await cleanupWorkflow(id);
  for (const roleId of touchedRoles) await deleteRole(roleId).catch(() => {});
  redis.disconnect();
});

describe("backend golden path create-validate-deploy-run", () => {
  test("creates, validates, deploys, starts, and records work item dispatch through backend contracts", async () => {
    const workflowId = `${RUN}-success`;
    const roleId = `${workflowId}-reviewer`;
    const workflow = workflowDefinition(workflowId, roleId);
    touchedWorkflows.add(workflowId);
    touchedRoles.add(roleId);

    const roleCreate = await act("role.create", {
      role_id: roleId,
      name: "Backend golden reviewer",
      assignees: [],
      strategy: "manual",
    });
    expect(roleCreate).toMatchObject({
      ok: true,
      status: 201,
      action: "role.create",
      data: { role_id: roleId, strategy: "manual" },
    });

    const created = await act("workflow.create", { ...workflow, draft: false });
    expect(created).toMatchObject({
      ok: true,
      status: 201,
      action: "workflow.create",
      data: { id: workflowId, lifecycle_state: "validated" },
    });

    const validation = await act("workflow.validate", { id: workflowId });
    expect(validation).toMatchObject({
      ok: true,
      status: 200,
      action: "workflow.validate",
      data: {
        workflow_id: workflowId,
        readiness: "ready",
        gates: {
          deployment_blocker: false,
          case_start_blocker: false,
        },
        errors: [],
      },
    });

    const deployed = await act("workflow.deploy", {
      id: workflowId,
      deployed_by: "backend-golden-path",
      idempotency_key: `${workflowId}:deploy`,
    });
    expect(deployed).toMatchObject({
      ok: true,
      status: 200,
      action: "workflow.deploy",
      data: {
        id: workflowId,
        lifecycle_state: "executable",
        deploy_version: 1,
        last_deploy: {
          status: "succeeded",
          source: "workflow.deploy",
          side_effects: {
            ok: true,
            workflow_id: workflowId,
            deployment_id: `${workflowId}:v1`,
            deploy_version: 1,
          },
        },
      },
    });
    await expect(getWorkflowDeploymentRecord(workflowId, 1)).resolves.toMatchObject({
      workflow_id: workflowId,
      deploy_version: 1,
      status: "completed",
    });

    const started = await act("case.start", {
      process_id: workflowId,
      subject: "Backend golden run",
      payload: { source: "backend-golden-path", priority: "high" },
    });
    expect(started).toMatchObject({
      ok: true,
      status: 201,
      action: "case.start",
      data: {
        process_id: workflowId,
        process_version: "1.0.0",
        subject: "Backend golden run",
        status: "running",
        position: "review",
      },
    });

    const caseId = (started.data as any).case_id as string;
    const workItems = await listWorkItems({ case_id: caseId, status: "pending", limit: 10 });
    expect(workItems.items).toHaveLength(1);
    const workItem = workItems.items[0];
    expect(workItem).toMatchObject({
      case_id: caseId,
      process_id: workflowId,
      element_id: "review",
      label: "Review request",
      assignee: roleId,
      status: "pending",
      input: { source: "backend-golden-path", priority: "high" },
    });

    const idempotencyKey = workItemDispatchIdempotencyKey({
      case_id: caseId,
      work_item_id: workItem.work_item_id,
    });
    const dispatchEffect = await getRuntimeEffect(runtimeEffectIdFromIdempotencyKey(idempotencyKey));
    expect(dispatchEffect).toMatchObject({
      kind: "workitem.dispatch",
      idempotency_key: idempotencyKey,
      status: "pending",
      links: {
        workflow_id: workflowId,
        case_id: caseId,
        work_item_id: workItem.work_item_id,
        event_id: "review",
      },
      payload: {
        role: roleId,
        label: "Review request",
        case_id: caseId,
        work_item_id: workItem.work_item_id,
        process_id: workflowId,
        element_id: "review",
        payload: { source: "backend-golden-path", priority: "high" },
      },
    });
    if (!dispatchEffect) throw new Error("workitem.dispatch effect was not persisted");
    touchedEffects.set(dispatchEffect.effect_id, dispatchEffect);

    const dispatchResult = await handleWorkItemDispatchEffect(dispatchEffect);
    expect(dispatchResult).toMatchObject({
      receipt: {
        data: {
          deduplicated: false,
          dispatch: {
            route: "manual",
            work_item_id: workItem.work_item_id,
            role: roleId,
            target_type: "manual",
            target_ids: [],
            strategy: "no-target",
            dispatch_status: "manual",
            route_reason: "no-target",
          },
        },
      },
    });

    await expect(getWorkflow(workflowId)).resolves.toMatchObject({
      id: workflowId,
      lifecycle_state: "executable",
      deploy_version: 1,
    });
  });

  test("blocks case.start before durable deploy makes the workflow executable", async () => {
    const workflowId = `${RUN}-blocked-start`;
    const roleId = `${workflowId}-reviewer`;
    const workflow = workflowDefinition(workflowId, roleId);
    touchedWorkflows.add(workflowId);
    touchedRoles.add(roleId);

    await act("role.create", {
      role_id: roleId,
      name: "Backend blocked reviewer",
      assignees: [],
      strategy: "manual",
    });
    const created = await act("workflow.create", { ...workflow, draft: false });
    expect(created).toMatchObject({
      ok: true,
      data: { lifecycle_state: "validated" },
    });

    const blockedStart = await act("case.start", {
      process_id: workflowId,
      subject: "Should not start before deploy",
      payload: {},
    });
    expect(blockedStart).toMatchObject({
      ok: false,
      status: 409,
      action: "case.start",
      data: {
        code: "WORKFLOW_NOT_EXECUTABLE",
        process_id: workflowId,
        lifecycle_state: "validated",
      },
    });

    const cases = await act("case.list", { process_id: workflowId });
    expect(cases).toMatchObject({
      ok: true,
      status: 200,
      data: { cases: [], total: 0 },
    });
  });
});
