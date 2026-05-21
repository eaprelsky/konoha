import { afterAll, describe, expect, test } from "bun:test";
import { createTestRedis } from "./redis-test-utils";
import { executeActionDirect } from "../src/action-executor";
import { createCase, deleteCase, deleteCasesByProcess, handleEventFired, loadCase } from "../src/runtime";
import { completeWorkItem } from "../src/runtime/work-items";
import { createRole, deleteRole } from "../src/runtime/roles";
import { createWorkflow, updateWorkflow, getWorkflow, type WorkflowDefinition } from "../src/workflow-loader";
import { pgDeleteWorkflow } from "../src/storage/pg";
import { deleteReminder, listReminders } from "../src/runtime/reminders";

const redis = createTestRedis();
const RUN = `snapshot-binding-${Date.now()}`;
const touched = new Set<string>();
const touchedRoles = new Set<string>();

function workflow(id: string, secondLabel: string): WorkflowDefinition {
  return {
    id,
    version: "1.0.0",
    name: `Snapshot binding ${id}`,
    elements: [
      { id: "start", type: "event", label: "Start", trigger: { kind: "manual", manual_override: true } },
      { id: "first", type: "function", label: "First approval", role: `${RUN}-reviewer` },
      { id: "middle", type: "event", label: "First approved", trigger: { kind: "manual", manual_override: true } },
      { id: "second", type: "function", label: secondLabel, role: `${RUN}-reviewer` },
      { id: "done", type: "event", label: "Done", trigger: { kind: "manual", manual_override: true } },
    ],
    flow: [["start", "first"], ["first", "middle"], ["middle", "second"], ["second", "done"]],
  };
}

async function cleanupWorkflow(id: string): Promise<void> {
  const caseIds = await redis.smembers(`konoha:cases:process:${id}`);
  const reminders = await listReminders();
  for (const reminder of reminders.filter(r => r.process_id === id)) {
    await deleteReminder(reminder.reminder_id).catch(() => {});
  }
  for (const caseId of caseIds) {
    const waitIds = await redis.smembers(`konoha:event-waits:case:${caseId}`);
    for (const waitId of waitIds) {
      const raw = await redis.get(`event-wait:${waitId}`);
      if (raw) {
        const wait = JSON.parse(raw);
        if (wait.status) await redis.srem(`konoha:event-waits:status:${wait.status}`, waitId);
      }
      await redis.srem("konoha:event-waits:active", waitId);
      await redis.del(`event-wait:${waitId}`);
    }
    await redis.del(`konoha:event-waits:case:${caseId}`);
    await deleteCase(caseId).catch(() => undefined);
  }
  await deleteCasesByProcess(id).catch(() => 0);
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [nextCursor, batch] = await redis.scan(cursor, "MATCH", `workflow:deployed:${id}:*`, "COUNT", 100) as [string, string[]];
    keys.push(...batch);
    cursor = nextCursor;
  } while (cursor !== "0");
  cursor = "0";
  do {
    const [nextCursor, batch] = await redis.scan(cursor, "MATCH", `workflow:version:${id}:*`, "COUNT", 100) as [string, string[]];
    keys.push(...batch);
    cursor = nextCursor;
  } while (cursor !== "0");
  if (keys.length > 0) await redis.del(...keys);
  await redis.del(`workflow:${id}`);
  await redis.del(`konoha:workflow:versionctr:${id}`);
  await redis.srem("konoha:workflow:index", id);
  await pgDeleteWorkflow(id).catch(() => {});
}

async function pendingWorkItems(caseId: string): Promise<Array<Record<string, any>>> {
  const ids = await redis.smembers(`konoha:workitems:case:${caseId}`);
  const raws = await Promise.all(ids.map(id => redis.get(`workitem:${id}`)));
  return raws.filter(Boolean).map(raw => JSON.parse(raw as string)).filter(item => item.status === "pending");
}

async function pendingWorkItem(caseId: string, elementId: string): Promise<Record<string, any>> {
  const item = (await pendingWorkItems(caseId)).find(wi => wi.element_id === elementId);
  if (!item) throw new Error(`Missing pending work item ${elementId} for case ${caseId}`);
  return item;
}

afterAll(async () => {
  for (const id of touched) await cleanupWorkflow(id);
  for (const roleId of touchedRoles) await deleteRole(roleId).catch(() => {});
  redis.disconnect();
});

describe("runtime workflow snapshot binding", () => {
  test("running cases keep their deployed snapshot across draft edits and redeploys", async () => {
    const id = `${RUN}-versioned`;
    const roleId = `${RUN}-reviewer`;
    touched.add(id);
    touchedRoles.add(roleId);

    await createRole({
      role_id: roleId,
      name: "Snapshot reviewer",
      assignees: ["operator-1"],
      strategy: "round-robin",
      required_capabilities: [],
    });
    await createWorkflow(workflow(id, "Old second step"));
    const deploy = await executeActionDirect("workflow.deploy", { id, deployed_by: "operator-1" });
    expect(deploy?.status).toBe(200);

    const oldCase = await createCase(id, "old case", {});
    expect(oldCase.workflow_snapshot).toMatchObject({
      workflow_id: id,
      deploy_version: 1,
      source: "workflow.deploy",
    });
    expect(oldCase.workflow_snapshot?.snapshot_key).toBe(`workflow:deployed:${id}:v1`);

    await updateWorkflow(id, workflow(id, "New second step"), { draft: true });
    const currentDraft = await getWorkflow(id);
    expect(currentDraft?.lifecycle_state).toBe("draft");

    const oldFirst = await pendingWorkItem(oldCase.case_id, "first");
    await completeWorkItem(oldFirst.work_item_id, { approved: true });
    await handleEventFired({
      event_id: "middle",
      process_id: id,
      instance_id: oldCase.case_id,
      source_data: { confirmed: "old" },
      idempotency_key: `${RUN}-old-middle`,
    });
    const oldSecond = await pendingWorkItem(oldCase.case_id, "second");
    expect(oldSecond.label).toBe("Old second step");

    const redeploy = await executeActionDirect("workflow.deploy", { id, deployed_by: "operator-2" });
    expect(redeploy?.status).toBe(200);

    const newCase = await createCase(id, "new case", {});
    expect(newCase.workflow_snapshot).toMatchObject({
      workflow_id: id,
      deploy_version: 2,
      source: "workflow.deploy",
    });
    const newFirst = await pendingWorkItem(newCase.case_id, "first");
    await completeWorkItem(newFirst.work_item_id, { approved: true });
    await handleEventFired({
      event_id: "middle",
      process_id: id,
      instance_id: newCase.case_id,
      source_data: { confirmed: "new" },
      idempotency_key: `${RUN}-new-middle`,
    });
    const newSecond = await pendingWorkItem(newCase.case_id, "second");
    expect(newSecond.label).toBe("New second step");
  });

  test("retired workflows block new starts but existing bound cases can advance", async () => {
    const id = `${RUN}-retired-existing`;
    const roleId = `${RUN}-reviewer`;
    touched.add(id);
    touchedRoles.add(roleId);

    await createRole({
      role_id: roleId,
      name: "Snapshot reviewer",
      assignees: ["operator-1"],
      strategy: "round-robin",
      required_capabilities: [],
    }).catch(() => undefined);
    await createWorkflow(workflow(id, "Retired second step"));
    const deploy = await executeActionDirect("workflow.deploy", { id, deployed_by: "operator-1" });
    expect(deploy?.status).toBe(200);

    const kase = await createCase(id, "existing case", {});
    const retire = await executeActionDirect("workflow.retire", { id, mode: "retire_only", retired_by: "operator-1" });
    expect(retire?.status).toBe(200);

    await expect(createCase(id, "blocked new case", {})).rejects.toThrow("Workflow is not executable");

    const first = await pendingWorkItem(kase.case_id, "first");
    await completeWorkItem(first.work_item_id, { approved: true });
    await handleEventFired({
      event_id: "middle",
      process_id: id,
      instance_id: kase.case_id,
      source_data: { confirmed: "retired" },
      idempotency_key: `${RUN}-retired-middle`,
    });
    const second = await pendingWorkItem(kase.case_id, "second");
    expect(second.label).toBe("Retired second step");

    const loaded = await loadCase(kase.case_id);
    expect(loaded?.workflow_snapshot?.snapshot_key).toBe(`workflow:deployed:${id}:v1`);
  });
});
