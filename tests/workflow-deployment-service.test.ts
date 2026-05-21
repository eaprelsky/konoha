import { afterAll, describe, expect, test } from "bun:test";
import { executeActionDirect } from "../src/action-executor";
import { cancelSubscriptionsByProcessAndInstance } from "../src/event-manager";
import { SUBSCRIPTIONS_KEY } from "../src/events/subscriptions";
import { deleteCasesByProcess } from "../src/runtime";
import { pgDeleteWorkflow } from "../src/storage/pg";
import {
  createWorkflow,
  getWorkflow,
  updateWorkflow,
  type WorkflowDefinition,
} from "../src/workflow-loader";
import { materializeWorkflowDeploymentSubscriptions } from "../src/workflow-deployment-service";
import { createTestRedis } from "./redis-test-utils";

const redis = createTestRedis();
const RUN = `workflow-deploy-service-${Date.now()}`;
const touched = new Set<string>();

function workflow(id: string, cron = "*/5 * * * *"): WorkflowDefinition {
  return {
    id,
    version: "1.0.0",
    name: `Deployment service ${id}`,
    elements: [
      { id: "start", type: "event", label: "Start", trigger: { kind: "timer", cron, confidence: 1 } },
      { id: "task", type: "function", label: "Review", role: "reviewer" },
      { id: "done", type: "event", label: "Done", trigger: { kind: "manual", manual_override: true } },
    ],
    flow: [["start", "task"], ["task", "done"]],
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

async function cleanupWorkflow(id: string): Promise<void> {
  await deleteCasesByProcess(id).catch(() => 0);
  await cancelSubscriptionsByProcessAndInstance(id, "new").catch(() => 0);
  const subs = await subscriptionsForProcess(id);
  if (subs.length > 0) await redis.hdel(SUBSCRIPTIONS_KEY, ...subs.map(sub => sub.id));
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [nextCursor, batch] = await redis.scan(cursor, "MATCH", `workflow:deployed:${id}:*`, "COUNT", 100) as [string, string[]];
    keys.push(...batch);
    cursor = nextCursor;
  } while (cursor !== "0");
  if (keys.length > 0) await redis.del(...keys);
  await redis.del(`workflow:${id}`);
  await redis.del(`konoha:workflow:versionctr:${id}`);
  await redis.srem("konoha:workflow:index", id);
  await pgDeleteWorkflow(id).catch(() => {});
}

afterAll(async () => {
  for (const id of touched) await cleanupWorkflow(id);
  redis.disconnect();
});

describe("workflow deployment service", () => {
  test("workflow.deploy returns subscription receipt and redeploy is idempotent for unchanged start triggers", async () => {
    const id = `${RUN}-idempotent`;
    touched.add(id);
    await createWorkflow(workflow(id));

    const first = await executeActionDirect("workflow.deploy", { id, deployed_by: "operator-1" });
    expect(first?.status).toBe(200);
    expect((first?.data as any).deployment).toMatchObject({
      ok: true,
      workflow_id: id,
      deploy_version: 1,
      deployment_id: `${id}:v1`,
      subscriptions: {
        desired: 1,
        created: [expect.objectContaining({
          event_id: "start",
          trigger_kind: "timer",
          status: "created",
          operation_key: `${id}:v1:start`,
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
      deployed_by: "operator-1",
    });

    const second = await executeActionDirect("workflow.deploy", { id, deployed_by: "operator-2" });
    expect(second?.status).toBe(200);
    expect((second?.data as any).deployment).toMatchObject({
      ok: true,
      workflow_id: id,
      deploy_version: 2,
      deployment_id: `${id}:v2`,
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
      deployed_by: "operator-2",
    });
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
      subscriptions: {
        desired: 1,
        created: [],
        cancelled: [],
        unchanged: [],
        failed: [expect.objectContaining({
          event_id: "start",
          status: "failed",
          reason: "create_subscription_failed",
          error: "subscription backend unavailable",
        })],
      },
    });
    const stored = await getWorkflow(id);
    expect(stored?.lifecycle_state).toBe("validated");
    expect(await activeSubscriptionsForProcess(id)).toEqual([]);
  });
});
