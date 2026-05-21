import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { executeActionDirect } from "../src/action-executor";
import { cancelSubscriptionsByProcessAndInstance, createSubscriptionProgrammatic } from "../src/event-manager";
import { SUBSCRIPTIONS_KEY } from "../src/events/subscriptions";
import { deleteCasesByProcess } from "../src/runtime";
import { createRole, deleteRole } from "../src/runtime/roles";
import { pgDeleteWorkflow } from "../src/storage/pg";
import {
  createWorkflow,
  getWorkflow,
  updateWorkflow,
  type WorkflowDefinition,
} from "../src/workflow-loader";
import {
  getWorkflowDeploymentRecord,
  listWorkflowDeploymentRecords,
  materializeWorkflowDeploymentSubscriptions,
  setWorkflowDeploymentSubscriptionDepsForTest,
  workflowDeploymentRecordIndexKey,
  workflowDeploymentRecordKey,
  WORKFLOW_DEPLOY_RECORD_GLOBAL_INDEX,
} from "../src/workflow-deployment-service";
import { createTestRedis } from "./redis-test-utils";

const redis = createTestRedis();
const RUN = `workflow-deploy-service-${Date.now()}`;
const touched = new Set<string>();
const REVIEWER_ROLE = `${RUN}-reviewer`;

function workflow(id: string, cron = "*/5 * * * *", role = REVIEWER_ROLE): WorkflowDefinition {
  return {
    id,
    version: "1.0.0",
    name: `Deployment service ${id}`,
    elements: [
      { id: "start", type: "event", label: "Start", trigger: { kind: "timer", cron, confidence: 1 } },
      { id: "task", type: "function", label: "Review", role },
      { id: "done", type: "event", label: "Done", trigger: { kind: "manual", manual_override: true } },
    ],
    flow: [["start", "task"], ["task", "done"]],
  };
}

function workflowWithTwoStartEvents(id: string, role = REVIEWER_ROLE): WorkflowDefinition {
  return {
    id,
    version: "1.0.0",
    name: `Deployment service ${id}`,
    elements: [
      { id: "start-a", type: "event", label: "Start A", trigger: { kind: "timer", cron: "*/5 * * * *", confidence: 1 } },
      { id: "start-b", type: "event", label: "Start B", trigger: { kind: "timer", cron: "*/10 * * * *", confidence: 1 } },
      { id: "task", type: "function", label: "Review", role },
      { id: "done", type: "event", label: "Done", trigger: { kind: "manual", manual_override: true } },
    ],
    flow: [["start-a", "task"], ["start-b", "task"], ["task", "done"]],
  };
}

async function subscriptionsForProcess(processId: string): Promise<Array<Record<string, any>>> {
  const raw = await redis.hgetall(SUBSCRIPTIONS_KEY).catch(() => ({} as Record<string, string>));
  return Object.values(raw)
    .map(value => {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    })
    .filter((sub): sub is Record<string, any> => Boolean(sub) && sub.process_id === processId);
}

async function activeSubscriptionsForProcess(processId: string): Promise<Array<Record<string, any>>> {
  return (await subscriptionsForProcess(processId)).filter(sub => sub.status === "active");
}

async function activeStartSubscriptionsForProcess(processId: string): Promise<Array<Record<string, any>>> {
  return (await activeSubscriptionsForProcess(processId)).filter(sub => sub.instance_id === "new");
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

async function deployRecordKeys(processId: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [nextCursor, batch] = await redis.scan(cursor, "MATCH", `workflow:deploy-record:${processId}:*`, "COUNT", 100) as [string, string[]];
    keys.push(...batch);
    cursor = nextCursor;
  } while (cursor !== "0");
  return keys;
}

async function cleanupWorkflow(id: string): Promise<void> {
  await deleteCasesByProcess(id).catch(() => 0);
  await cancelSubscriptionsByProcessAndInstance(id, "new").catch(() => 0);
  const subs = await subscriptionsForProcess(id);
  if (subs.length > 0) await redis.hdel(SUBSCRIPTIONS_KEY, ...subs.map(sub => sub.id));
  const keys = await deployedSnapshotKeys(id);
  if (keys.length > 0) await redis.del(...keys);
  const deployKeys = await deployRecordKeys(id);
  if (deployKeys.length > 0) {
    await redis.del(...deployKeys);
    await redis.zrem(WORKFLOW_DEPLOY_RECORD_GLOBAL_INDEX, ...deployKeys).catch(() => 0);
  }
  await redis.del(workflowDeploymentRecordIndexKey(id));
  await redis.del(`workflow:${id}`);
  await redis.del(`konoha:workflow:versionctr:${id}`);
  await redis.srem("konoha:workflow:index", id);
  await pgDeleteWorkflow(id).catch(() => {});
}

beforeAll(async () => {
  await createRole({
    role_id: REVIEWER_ROLE,
    name: "Deployment reviewer",
    assignees: [],
    strategy: "manual",
    required_capabilities: [],
  });
});

afterAll(async () => {
  for (const id of touched) await cleanupWorkflow(id);
  await deleteRole(REVIEWER_ROLE).catch(() => {});
  redis.disconnect();
});

describe("workflow deployment service", () => {
  test("workflow save and update paths do not materialize start-event subscriptions", async () => {
    const id = `${RUN}-save-update-no-subscribe`;
    touched.add(id);

    const created = await createWorkflow(workflow(id), { lifecycleState: "executable" });
    expect(created.errors).toEqual([]);
    expect(await activeSubscriptionsForProcess(id)).toEqual([]);

    const updated = await updateWorkflow(id, workflow(id, "*/10 * * * *"), { lifecycleState: "executable" });
    expect(updated).not.toBeNull();
    expect(await activeSubscriptionsForProcess(id)).toEqual([]);
  });

  test("workflow.deploy returns subscription receipt and redeploy is idempotent for unchanged start triggers", async () => {
    const id = `${RUN}-idempotent`;
    touched.add(id);
    await createWorkflow(workflow(id));

    const firstIdempotencyKey = `${id}:operator-request:1`;
    const first = await executeActionDirect("workflow.deploy", { id, deployed_by: "operator-1", idempotency_key: firstIdempotencyKey });
    expect(first?.status).toBe(200);
    expect((first?.data as any).deployment).toMatchObject({
      ok: true,
      workflow_id: id,
      deploy_version: 1,
      deployment_id: `${id}:v1`,
      transaction: {
        transaction_id: `${id}:v1:transaction`,
        idempotency_key: `workflow.deploy:${id}:v1:${firstIdempotencyKey}`,
        caller_idempotency_key: firstIdempotencyKey,
        workflow_id: id,
        deploy_version: 1,
        deployment_id: `${id}:v1`,
        status: "completed",
        commit_order: [
          "validate",
          "commit_executable_workflow",
          "save_deployed_snapshot",
          "materialize_subscription_diff",
          "persist_deploy_receipt",
        ],
        records: {
          workflow: `workflow:${id}`,
          deployed_snapshot: `workflow:deployed:${id}:v1`,
          deploy_receipt: "workflow.last_deploy.side_effects",
          deploy_record: workflowDeploymentRecordKey(id, 1),
        },
      },
      subscriptions: {
        desired: 1,
        created: [expect.objectContaining({
          event_id: "start",
          trigger_kind: "timer",
          status: "created",
          operation_key: `${id}:v1:start`,
          idempotency_key: `workflow.deploy:${id}:v1:${firstIdempotencyKey}:subscription:create:start`,
        })],
        cancelled: [],
        unchanged: [],
        failed: [],
      },
    });
    expect((first?.data as any).last_deploy.side_effects).toMatchObject((first?.data as any).deployment);

    const activeAfterFirst = await activeSubscriptionsForProcess(id);
    expect(activeAfterFirst).toHaveLength(1);
    expect(activeAfterFirst[0]).toMatchObject({
      event_id: "start",
      deploy_version: 1,
      deployment_id: `${id}:v1`,
      operation_key: `${id}:v1:start`,
      idempotency_key: `workflow.deploy:${id}:v1:${firstIdempotencyKey}:subscription:create:start`,
      deployed_by: "operator-1",
    });
    const firstRecord = await getWorkflowDeploymentRecord(id, 1);
    expect(firstRecord).toMatchObject({
      schema_version: 1,
      workflow_id: id,
      deploy_version: 1,
      deployment_id: `${id}:v1`,
      record_key: workflowDeploymentRecordKey(id, 1),
      index_key: workflowDeploymentRecordIndexKey(id),
      status: "completed",
      deployed_by: "operator-1",
      transaction: {
        status: "completed",
        idempotency_key: `workflow.deploy:${id}:v1:${firstIdempotencyKey}`,
      },
      records: {
        deploy_record: workflowDeploymentRecordKey(id, 1),
      },
      subscription_diff: {
        desired: 1,
        created: [expect.objectContaining({ operation_key: `${id}:v1:start` })],
        cancelled: [],
        unchanged: [],
        failed: [],
      },
      receipt: {
        ok: true,
        deploy_version: 1,
      },
    });

    const second = await executeActionDirect("workflow.deploy", { id, deployed_by: "operator-2" });
    expect(second?.status).toBe(200);
    expect((second?.data as any).deployment).toMatchObject({
      ok: true,
      workflow_id: id,
      deploy_version: 2,
      deployment_id: `${id}:v2`,
      transaction: {
        idempotency_key: `workflow.deploy:${id}:v2`,
        status: "completed",
        retry_policy: {
          scope: "workflow_deploy_version",
          operation_key_template: "{workflow_id}:v{deploy_version}:{event_id}",
          duplicate_effect: "matching_active_subscription_is_unchanged",
        },
      },
      subscriptions: {
        desired: 1,
        created: [],
        cancelled: [],
        unchanged: [expect.objectContaining({
          event_id: "start",
          trigger_kind: "timer",
          status: "unchanged",
          subscription_id: activeAfterFirst[0].id,
          operation_key: `${id}:v2:start`,
          idempotency_key: `workflow.deploy:${id}:v2:subscription:unchanged:start`,
        })],
        failed: [],
      },
    });
    const activeAfterSecond = await activeSubscriptionsForProcess(id);
    expect(activeAfterSecond).toHaveLength(1);
    expect(activeAfterSecond[0]).toMatchObject({
      id: activeAfterFirst[0].id,
      deploy_version: 2,
      deployment_id: `${id}:v2`,
      operation_key: `${id}:v2:start`,
      idempotency_key: `workflow.deploy:${id}:v2:subscription:unchanged:start`,
      deployed_by: "operator-2",
    });
    const records = await listWorkflowDeploymentRecords(id);
    expect(records.map(record => record.deploy_version)).toEqual([1, 2]);
    expect(records[1]).toMatchObject({
      status: "completed",
      deploy_version: 2,
      subscription_diff: {
        desired: 1,
        unchanged: [expect.objectContaining({ operation_key: `${id}:v2:start` })],
      },
    });
  });

  test("workflow.undeploy cancels deploy-managed start subscriptions and preserves running case subscriptions", async () => {
    const id = `${RUN}-undeploy`;
    touched.add(id);
    await createWorkflow(workflow(id));

    const deployed = await executeActionDirect("workflow.deploy", { id, deployed_by: "operator-1" });
    expect(deployed?.status).toBe(200);
    expect(await activeStartSubscriptionsForProcess(id)).toHaveLength(1);

    const runtimeSub = await createSubscriptionProgrammatic({
      event_id: "waiting",
      process_id: id,
      process_name: "Running case",
      instance_id: "case-123",
      trigger: { kind: "manual", action: "complete", role: "reviewer" } as any,
    });

    const undeployed = await executeActionDirect("workflow.undeploy", { id, undeployed_by: "operator-2" });
    expect(undeployed?.status).toBe(200);
    expect((undeployed?.data as any)).toMatchObject({
      ok: true,
      workflow_id: id,
      action: "workflow.undeploy",
      lifecycle_state: "validated",
      undeployed_by: "operator-2",
      subscription_reconciliation: {
        ok: true,
        workflow_id: id,
        deploy_version: 1,
        source: "workflow.undeploy",
        reason: "workflow_undeployed",
        active_before: 1,
        cancelled: [expect.objectContaining({
          event_id: "start",
          status: "cancelled",
          reason: "workflow_undeployed",
        })],
        failed: [],
        preserved_running_case_subscriptions: true,
      },
    });
    expect(await activeStartSubscriptionsForProcess(id)).toEqual([]);

    const rawRuntimeSub = await redis.hget(SUBSCRIPTIONS_KEY, runtimeSub.subscription_id);
    expect(rawRuntimeSub).toBeTruthy();
    expect(JSON.parse(rawRuntimeSub!)).toMatchObject({
      id: runtimeSub.subscription_id,
      process_id: id,
      instance_id: "case-123",
      status: "active",
    });

    const blockedStart = await executeActionDirect("case.start", {
      process_id: id,
      subject: "blocked after undeploy",
      payload: {},
    });
    expect(blockedStart?.status).toBe(409);
    expect((blockedStart?.data as any)).toMatchObject({
      code: "WORKFLOW_NOT_EXECUTABLE",
      lifecycle_state: "validated",
    });

    const saved = await getWorkflow(id);
    expect(saved).toMatchObject({
      lifecycle_state: "validated",
      last_deploy: {
        status: "blocked",
        source: "workflow.undeploy",
        side_effects: {
          type: "start_subscription_reconciliation",
          ok: true,
        },
      },
    });
  });

  test("workflow.undeploy reports failed reconciliation and leaves start subscriptions retryable", async () => {
    const id = `${RUN}-undeploy-failed-reconcile`;
    touched.add(id);
    await createWorkflow(workflow(id));

    const deployed = await executeActionDirect("workflow.deploy", { id, deployed_by: "operator-1" });
    expect(deployed?.status).toBe(200);
    const activeBefore = await activeStartSubscriptionsForProcess(id);
    expect(activeBefore).toHaveLength(1);

    const restoreDeps = setWorkflowDeploymentSubscriptionDepsForTest({
      async cancelResources() {
        throw new Error("simulated cancel failure");
      },
    });
    try {
      const undeployed = await executeActionDirect("workflow.undeploy", { id, undeployed_by: "operator-2" });
      expect(undeployed?.status).toBe(502);
      expect((undeployed?.data as any)).toMatchObject({
        ok: false,
        workflow_id: id,
        action: "workflow.undeploy",
        lifecycle_state: "validated",
        subscription_reconciliation: {
          ok: false,
          source: "workflow.undeploy",
          reason: "workflow_undeployed",
          active_before: 1,
          cancelled: [],
          failed: [expect.objectContaining({
            event_id: "start",
            status: "failed",
            error: "simulated cancel failure",
          })],
          preserved_running_case_subscriptions: true,
        },
      });
    } finally {
      restoreDeps();
    }

    expect(await activeStartSubscriptionsForProcess(id)).toHaveLength(1);
    const saved = await getWorkflow(id);
    expect(saved).toMatchObject({
      lifecycle_state: "validated",
      needs_review: true,
      last_deploy: {
        status: "blocked",
        source: "workflow.undeploy",
        side_effects: {
          type: "start_subscription_reconciliation",
          ok: false,
        },
      },
    });
  });

  test("workflow.retire cancels deploy-managed starts in retire_only mode without cancelling running case subscriptions", async () => {
    const id = `${RUN}-retire-start-subscriptions`;
    touched.add(id);
    await createWorkflow(workflow(id));

    const deployed = await executeActionDirect("workflow.deploy", { id, deployed_by: "operator-1" });
    expect(deployed?.status).toBe(200);
    expect(await activeStartSubscriptionsForProcess(id)).toHaveLength(1);

    const runtimeSub = await createSubscriptionProgrammatic({
      event_id: "waiting",
      process_id: id,
      instance_id: "case-456",
      trigger: { kind: "manual", action: "complete", role: "reviewer" } as any,
    });

    const retired = await executeActionDirect("workflow.retire", {
      id,
      mode: "retire_only",
      retired_by: "operator-2",
    });
    expect(retired?.status).toBe(200);
    expect((retired?.data as any)).toMatchObject({
      ok: true,
      workflow_id: id,
      action: "workflow.retire",
      lifecycle_state: "retired",
      cancelled_subscriptions: 1,
      subscription_reconciliation: {
        ok: true,
        source: "workflow.retire",
        reason: "workflow_retired",
        active_before: 1,
        cancelled: [expect.objectContaining({ event_id: "start", status: "cancelled" })],
        failed: [],
        preserved_running_case_subscriptions: true,
      },
    });
    expect(await activeStartSubscriptionsForProcess(id)).toEqual([]);
    const rawRuntimeSub = await redis.hget(SUBSCRIPTIONS_KEY, runtimeSub.subscription_id);
    expect(JSON.parse(rawRuntimeSub!)).toMatchObject({
      process_id: id,
      instance_id: "case-456",
      status: "active",
    });
  });

  test("workflow.retire reports failed start-subscription reconciliation as non-success", async () => {
    const id = `${RUN}-retire-failed-reconcile`;
    touched.add(id);
    await createWorkflow(workflow(id));

    const deployed = await executeActionDirect("workflow.deploy", { id, deployed_by: "operator-1" });
    expect(deployed?.status).toBe(200);
    expect(await activeStartSubscriptionsForProcess(id)).toHaveLength(1);

    const restoreDeps = setWorkflowDeploymentSubscriptionDepsForTest({
      async cancelResources() {
        throw new Error("simulated retire cancel failure");
      },
    });
    try {
      const retired = await executeActionDirect("workflow.retire", {
        id,
        mode: "retire_only",
        retired_by: "operator-2",
      });
      expect(retired?.status).toBe(502);
      expect((retired?.data as any)).toMatchObject({
        ok: false,
        error: "Start subscription reconciliation failed",
        code: "WORKFLOW_START_SUBSCRIPTION_RECONCILIATION_FAILED",
        workflow_id: id,
        action: "workflow.retire",
        lifecycle_state: "retired",
        cancelled_subscriptions: 0,
        cleanup_skipped: false,
        subscription_reconciliation: {
          ok: false,
          source: "workflow.retire",
          reason: "workflow_retired",
          active_before: 1,
          cancelled: [],
          failed: [expect.objectContaining({
            event_id: "start",
            status: "failed",
            error: "simulated retire cancel failure",
          })],
          preserved_running_case_subscriptions: true,
        },
      });
    } finally {
      restoreDeps();
    }

    expect(await activeStartSubscriptionsForProcess(id)).toHaveLength(1);
  });

  test("workflow.delete reports failed start-subscription reconciliation as non-success and skips cleanup", async () => {
    const id = `${RUN}-delete-failed-reconcile`;
    touched.add(id);
    await createWorkflow(workflow(id));

    const deployed = await executeActionDirect("workflow.deploy", { id, deployed_by: "operator-1" });
    expect(deployed?.status).toBe(200);
    expect(await activeStartSubscriptionsForProcess(id)).toHaveLength(1);

    const restoreDeps = setWorkflowDeploymentSubscriptionDepsForTest({
      async cancelResources() {
        throw new Error("simulated delete cancel failure");
      },
    });
    try {
      const deleted = await executeActionDirect("workflow.delete", { id });
      expect(deleted?.status).toBe(502);
      expect((deleted?.data as any)).toMatchObject({
        ok: false,
        error: "Start subscription reconciliation failed",
        code: "WORKFLOW_START_SUBSCRIPTION_RECONCILIATION_FAILED",
        workflow_id: id,
        action: "workflow.delete",
        lifecycle_state: "retired",
        deleted_cases: 0,
        deleted_work_items: 0,
        cancelled_subscriptions: 0,
        cleanup_skipped: true,
        subscription_reconciliation: {
          ok: false,
          source: "workflow.delete",
          reason: "workflow_retired",
          active_before: 1,
          failed: [expect.objectContaining({
            event_id: "start",
            status: "failed",
            error: "simulated delete cancel failure",
          })],
          preserved_running_case_subscriptions: true,
        },
      });
    } finally {
      restoreDeps();
    }

    expect(await activeStartSubscriptionsForProcess(id)).toHaveLength(1);
  });

  test("redeploy cancels stale start subscriptions and creates changed trigger subscriptions", async () => {
    const id = `${RUN}-changed`;
    touched.add(id);
    await createWorkflow(workflow(id, "*/5 * * * *"));
    const first = await executeActionDirect("workflow.deploy", { id, deployed_by: "operator-1" });
    expect(first?.status).toBe(200);
    const firstSub = (await activeSubscriptionsForProcess(id))[0];

    await updateWorkflow(id, workflow(id, "*/10 * * * *"), { draft: true });
    const second = await executeActionDirect("workflow.deploy", { id, deployed_by: "operator-2" });

    expect(second?.status).toBe(200);
    expect((second?.data as any).deployment.subscriptions).toMatchObject({
      desired: 1,
      created: [expect.objectContaining({
        event_id: "start",
        status: "created",
        operation_key: `${id}:v2:start`,
      })],
      cancelled: [expect.objectContaining({
        event_id: "start",
        previous_subscription_id: firstSub.id,
        status: "cancelled",
        reason: "trigger_changed",
      })],
      unchanged: [],
      failed: [],
    });
    const active = await activeSubscriptionsForProcess(id);
    expect(active).toHaveLength(1);
    expect(active[0].id).not.toBe(firstSub.id);
    expect(active[0].trigger).toMatchObject({ kind: "timer", cron: "*/10 * * * *" });
    const record = await getWorkflowDeploymentRecord(id, 2);
    expect(record).toMatchObject({
      status: "completed",
      deploy_version: 2,
      subscription_diff: {
        desired: 1,
        created: [expect.objectContaining({ operation_key: `${id}:v2:start` })],
        cancelled: [expect.objectContaining({
          previous_subscription_id: firstSub.id,
          reason: "trigger_changed",
        })],
        unchanged: [],
        failed: [],
      },
    });
  });

  test("caller idempotency key is scoped by deploy version for changed-trigger redeploy", async () => {
    const id = `${RUN}-caller-key-scoped`;
    const callerKey = "repeat-deploy-request";
    touched.add(id);
    await createWorkflow(workflow(id, "*/5 * * * *"));

    const first = await executeActionDirect("workflow.deploy", { id, deployed_by: "operator-1", idempotency_key: callerKey });
    expect(first?.status).toBe(200);
    const firstCreate = (first?.data as any).deployment.subscriptions.created[0];
    expect(firstCreate).toMatchObject({
      event_id: "start",
      operation_key: `${id}:v1:start`,
      idempotency_key: `workflow.deploy:${id}:v1:${callerKey}:subscription:create:start`,
    });

    await updateWorkflow(id, workflow(id, "*/10 * * * *"), { draft: true });
    const second = await executeActionDirect("workflow.deploy", { id, deployed_by: "operator-1", idempotency_key: callerKey });

    expect(second?.status).toBe(200);
    expect((second?.data as any).deployment.transaction).toMatchObject({
      idempotency_key: `workflow.deploy:${id}:v2:${callerKey}`,
      caller_idempotency_key: callerKey,
      deploy_version: 2,
    });
    const secondCreate = (second?.data as any).deployment.subscriptions.created[0];
    expect(secondCreate).toMatchObject({
      event_id: "start",
      operation_key: `${id}:v2:start`,
      idempotency_key: `workflow.deploy:${id}:v2:${callerKey}:subscription:create:start`,
    });
    expect(secondCreate.idempotency_key).not.toBe(firstCreate.idempotency_key);

    const active = await activeSubscriptionsForProcess(id);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      operation_key: `${id}:v2:start`,
      idempotency_key: `workflow.deploy:${id}:v2:${callerKey}:subscription:create:start`,
    });
  });

  test("materialization failures are explicit and do not mark workflow executable", async () => {
    const id = `${RUN}-failure`;
    touched.add(id);
    const def = workflow(id);
    await createWorkflow(def);

    const receipt = await materializeWorkflowDeploymentSubscriptions(def, {
      deploy_version: 1,
      deployed_at: new Date().toISOString(),
      deployed_by: "operator-1",
      source: "workflow.deploy",
    }, {
      createSubscription: async () => {
        throw new Error("subscription backend unavailable");
      },
      cancelResources: async () => {},
    });

    expect(receipt).toMatchObject({
      ok: false,
      workflow_id: id,
      deploy_version: 1,
      transaction: {
        idempotency_key: `workflow.deploy:${id}:v1`,
        status: "blocked",
      },
      subscriptions: {
        desired: 1,
        created: [],
        cancelled: [],
        unchanged: [],
        failed: [expect.objectContaining({
          event_id: "start",
          status: "failed",
          reason: "create_subscription_failed",
          idempotency_key: `workflow.deploy:${id}:v1:subscription:failed:start`,
          error: "subscription backend unavailable",
        })],
      },
    });
    const stored = await getWorkflow(id);
    expect(stored?.lifecycle_state).toBe("validated");
    expect(await activeSubscriptionsForProcess(id)).toEqual([]);
  });

  test("workflow.deploy commits executable state and snapshot before side effects and rolls back failed materialization", async () => {
    const id = `${RUN}-ordered-failure`;
    touched.add(id);
    await createWorkflow(workflow(id));
    let observedCommitted = false;
    const resetDeps = setWorkflowDeploymentSubscriptionDepsForTest({
      createSubscription: async () => {
        const committed = await getWorkflow(id);
        const snapshots = await deployedSnapshotKeys(id);
        expect(committed?.lifecycle_state).toBe("executable");
        expect(committed?.last_deploy).toMatchObject({
          status: "succeeded",
          deploy_version: 1,
          source: "workflow.deploy",
        });
        expect(snapshots).toContain(`workflow:deployed:${id}:v1`);
        observedCommitted = true;
        throw new Error("subscription backend unavailable");
      },
    });
    try {
      const deployed = await executeActionDirect("workflow.deploy", { id, deployed_by: "operator-1" });

      expect(observedCommitted).toBe(true);
      expect(deployed?.status).toBe(502);
      expect((deployed?.data as any)).toMatchObject({
        code: "WORKFLOW_DEPLOY_SIDE_EFFECT_FAILED",
        process_id: id,
        lifecycle_state: "validated",
        deployment: {
          ok: false,
          deploy_version: 1,
          transaction: {
            idempotency_key: `workflow.deploy:${id}:v1`,
            status: "blocked",
          },
          subscriptions: {
            failed: [expect.objectContaining({
              event_id: "start",
              reason: "create_subscription_failed",
              idempotency_key: `workflow.deploy:${id}:v1:subscription:failed:start`,
              error: "subscription backend unavailable",
            })],
          },
          rollback: [],
        },
      });
      const stored = await getWorkflow(id);
      expect(stored).toMatchObject({
        lifecycle_state: "validated",
        needs_review: true,
        last_deploy: {
          status: "blocked",
          source: "workflow.deploy",
        },
      });
      expect(await activeSubscriptionsForProcess(id)).toEqual([]);
      const record = await getWorkflowDeploymentRecord(id, 1);
      expect(record).toMatchObject({
        status: "blocked",
        failure: {
          code: "WORKFLOW_DEPLOY_SIDE_EFFECT_FAILED",
          message: "Workflow deploy failed while materializing subscriptions",
        },
        subscription_diff: {
          failed: [expect.objectContaining({
            event_id: "start",
            reason: "create_subscription_failed",
          })],
          rollback: [],
        },
        receipt: {
          ok: false,
          rollback: [],
        },
      });
    } finally {
      resetDeps();
    }
  });

  test("failed deploy rollback leaves created subscriptions retryable and retry does not duplicate them", async () => {
    const id = `${RUN}-rollback-retry`;
    touched.add(id);
    await createWorkflow(workflowWithTwoStartEvents(id));

    const runtimeSub = await createSubscriptionProgrammatic({
      event_id: "waiting",
      process_id: id,
      process_name: "Running case",
      instance_id: "case-rollback-retry",
      trigger: { kind: "manual", action: "complete", role: "reviewer" } as any,
    });

    let createAttempts = 0;
    let rollbackAttempts = 0;
    const resetDeps = setWorkflowDeploymentSubscriptionDepsForTest({
      async createSubscription(params) {
        createAttempts += 1;
        if (params.event_id === "start-b") {
          throw new Error("simulated start-b materialization failure");
        }
        return createSubscriptionProgrammatic(params);
      },
      async cancelResources(sub) {
        rollbackAttempts += 1;
        if (sub.event_id === "start-a") {
          throw new Error("simulated rollback cancel failure");
        }
      },
    });
    try {
      const failedDeploy = await executeActionDirect("workflow.deploy", { id, deployed_by: "operator-1" });
      expect(failedDeploy?.status).toBe(502);
      expect(createAttempts).toBe(2);
      expect(rollbackAttempts).toBe(1);
      expect((failedDeploy?.data as any)).toMatchObject({
        code: "WORKFLOW_DEPLOY_SIDE_EFFECT_FAILED",
        lifecycle_state: "validated",
        deployment: {
          ok: false,
          deploy_version: 1,
          subscriptions: {
            desired: 2,
            created: [expect.objectContaining({
              event_id: "start-a",
              status: "created",
              operation_key: `${id}:v1:start-a`,
            })],
            failed: [expect.objectContaining({
              event_id: "start-b",
              status: "failed",
              reason: "create_subscription_failed",
              error: "simulated start-b materialization failure",
            })],
          },
          rollback: [expect.objectContaining({
            event_id: "start-a",
            status: "failed",
            reason: "rollback_failed_deploy_materialization",
            error: "simulated rollback cancel failure",
          })],
        },
      });
    } finally {
      resetDeps();
    }

    const activeAfterFailedRollback = await activeStartSubscriptionsForProcess(id);
    expect(activeAfterFailedRollback).toHaveLength(1);
    expect(activeAfterFailedRollback[0]).toMatchObject({
      event_id: "start-a",
      status: "active",
      deploy_version: 1,
      deployment_id: `${id}:v1`,
      operation_key: `${id}:v1:start-a`,
    });
    const runtimeAfterFailure = await redis.hget(SUBSCRIPTIONS_KEY, runtimeSub.subscription_id);
    expect(JSON.parse(runtimeAfterFailure!)).toMatchObject({
      process_id: id,
      instance_id: "case-rollback-retry",
      status: "active",
    });
    const blockedRecord = await getWorkflowDeploymentRecord(id, 1);
    expect(blockedRecord).toMatchObject({
      status: "blocked",
      failure: {
        code: "WORKFLOW_DEPLOY_SIDE_EFFECT_FAILED",
      },
      subscription_diff: {
        rollback: [expect.objectContaining({
          event_id: "start-a",
          status: "failed",
          error: "simulated rollback cancel failure",
        })],
      },
      receipt: {
        ok: false,
        rollback: [expect.objectContaining({ status: "failed" })],
      },
    });

    const retry = await executeActionDirect("workflow.deploy", { id, deployed_by: "operator-2" });
    expect(retry?.status).toBe(200);
    expect((retry?.data as any).deployment).toMatchObject({
      ok: true,
      deploy_version: 2,
      subscriptions: {
        desired: 2,
        created: [expect.objectContaining({
          event_id: "start-b",
          status: "created",
          operation_key: `${id}:v2:start-b`,
        })],
        cancelled: [],
        unchanged: [expect.objectContaining({
          event_id: "start-a",
          subscription_id: activeAfterFailedRollback[0].id,
          status: "unchanged",
          operation_key: `${id}:v2:start-a`,
        })],
        failed: [],
      },
    });

    const activeAfterRetry = await activeStartSubscriptionsForProcess(id);
    expect(activeAfterRetry).toHaveLength(2);
    expect(activeAfterRetry.filter(sub => sub.event_id === "start-a")).toHaveLength(1);
    expect(activeAfterRetry.filter(sub => sub.event_id === "start-b")).toHaveLength(1);
    expect(activeAfterRetry.find(sub => sub.event_id === "start-a")).toMatchObject({
      id: activeAfterFailedRollback[0].id,
      deploy_version: 2,
      deployment_id: `${id}:v2`,
      operation_key: `${id}:v2:start-a`,
    });
    const runtimeAfterRetry = await redis.hget(SUBSCRIPTIONS_KEY, runtimeSub.subscription_id);
    expect(JSON.parse(runtimeAfterRetry!)).toMatchObject({
      process_id: id,
      instance_id: "case-rollback-retry",
      status: "active",
    });
    const completedRecord = await getWorkflowDeploymentRecord(id, 2);
    expect(completedRecord).toMatchObject({
      status: "completed",
      deploy_version: 2,
      subscription_diff: {
        created: [expect.objectContaining({ event_id: "start-b" })],
        unchanged: [expect.objectContaining({ event_id: "start-a" })],
        failed: [],
      },
    });
  });
});
