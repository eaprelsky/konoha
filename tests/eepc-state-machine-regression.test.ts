import { afterAll, describe, expect, test } from "bun:test";
import Redis from "ioredis";
import { createCase, deleteCasesByProcess, handleEventFired } from "../src/runtime";
import { completeWorkItem } from "../src/runtime/work-items";
import { loadActiveWaitsForCase } from "../src/runtime/event-waits";
import { deleteReminder, listReminders } from "../src/runtime/reminders";
import { createWorkflow } from "../src/workflow-loader";
import { pgDeleteWorkflow } from "../src/storage/pg";
import type { WorkflowDefinition } from "../src/workflow-loader";

const redis = new Redis({ host: "127.0.0.1", port: 6379, db: parseInt(process.env.REDIS_DB ?? "0") });
const RUN = `eepc-${Date.now()}`;

function wfId(name: string) {
  return `${RUN}-${name}`;
}

async function registerWorkflow(def: WorkflowDefinition): Promise<void> {
  await createWorkflow(def, { draft: true });
}

async function cleanupWorkflow(id: string): Promise<void> {
  const caseIds = await redis.smembers(`konoha:cases:process:${id}`);
  await new Promise(resolve => setTimeout(resolve, 50));
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

    const wiIds = await redis.smembers(`konoha:workitems:case:${caseId}`);
    if (wiIds.length > 0) {
      for (const wiId of wiIds) {
        const raw = await redis.get(`workitem:${wiId}`);
        if (raw) {
          const wi = JSON.parse(raw);
          if (wi.status) await redis.srem(`konoha:workitems:status:${wi.status}`, wiId);
          if (wi.assignee) await redis.srem(`konoha:workitems:assignee:${wi.assignee}`, wiId);
          if (wi.process_id) await redis.srem(`konoha:workitems:process:${wi.process_id}`, wiId);
        }
      }
      await redis.del(...wiIds.map(wiId => `workitem:${wiId}`));
      await redis.zrem("konoha:workitems:all", ...wiIds);
    }
    await redis.del(`konoha:workitems:case:${caseId}`);
  }
  await deleteCasesByProcess(id).catch(() => 0);
  const lateReminders = await listReminders();
  for (const reminder of lateReminders.filter(r => r.process_id === id)) {
    await deleteReminder(reminder.reminder_id).catch(() => {});
  }
  await redis.del(`workflow:${id}`);
  await redis.srem("konoha:workflow:index", id);
  await pgDeleteWorkflow(id).catch(() => {});
}

async function workItemsForCase(caseId: string): Promise<Array<Record<string, any>>> {
  const ids = await redis.smembers(`konoha:workitems:case:${caseId}`);
  const raws = await Promise.all(ids.map(id => redis.get(`workitem:${id}`)));
  return raws.filter(Boolean).map(raw => JSON.parse(raw as string));
}

afterAll(async () => {
  const workflowIds = await redis.smembers("konoha:workflow:index");
  for (const id of workflowIds) {
    if (id.startsWith(RUN)) await cleanupWorkflow(id);
  }
  const dedupKeys = await redis.keys(`konoha:event-dedup:${RUN}*`);
  if (dedupKeys.length > 0) await redis.del(...dedupKeys);
  redis.disconnect();
});

describe("eEPC state-machine regression suite", () => {
  test("start event to terminal event completes without external systems", async () => {
    const id = wfId("start-end");
    await registerWorkflow({
      id,
      version: "1.0.0",
      name: "Start/end regression",
      elements: [
        { id: "start", type: "event", label: "Started" },
        { id: "end", type: "event", label: "Finished" },
      ],
      flow: [["start", "end"]],
    });

    const kase = await createCase(id, "start-end", {});
    expect(kase.status).toBe("done");
    expect(kase.position).toBe("end");
    expect(kase.history.map(h => h.element_id)).toEqual(["start", "end"]);
  });

  test("manual function creates a pending work item and completion advances to end", async () => {
    const id = wfId("manual-function");
    await registerWorkflow({
      id,
      version: "1.0.0",
      name: "Manual function regression",
      elements: [
        { id: "start", type: "event", label: "Started" },
        { id: "review", type: "function", label: "Review", role: "qa" },
        { id: "end", type: "event", label: "Finished" },
      ],
      flow: [["start", "review"], ["review", "end"]],
    });

    const kase = await createCase(id, "manual-function", { input: 1 });
    expect(kase.status).toBe("running");
    expect(kase.position).toBe("review");

    const items = await workItemsForCase(kase.case_id);
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe("pending");
    expect(items[0].assignee).toBe("qa");

    const completed = await completeWorkItem(items[0].work_item_id, { approved: true });
    expect(completed.case?.status).toBe("done");
    expect(completed.case?.position).toBe("end");
    expect(completed.case?.history.find(h => h.element_id === "review")?.output).toEqual({ approved: true });
  });

  test("XOR gateway selects the first matching conditional branch", async () => {
    const id = wfId("xor");
    await registerWorkflow({
      id,
      version: "1.0.0",
      name: "XOR regression",
      elements: [
        { id: "start", type: "event", label: "Started" },
        { id: "route", type: "gateway", label: "Route", operator: "XOR" },
        { id: "pathA", type: "function", label: "Path A", role: "qa" },
        { id: "pathB", type: "function", label: "Path B", role: "qa" },
        { id: "end", type: "event", label: "Finished" },
      ],
      flow: [
        ["start", "route"],
        ["route", "pathA", "payload.path === 'a'"],
        ["route", "pathB", "payload.path === 'b'"],
        ["pathA", "end"],
        ["pathB", "end"],
      ],
    });

    const kase = await createCase(id, "xor", { path: "b" });
    expect(kase.status).toBe("running");
    expect(kase.position).toBe("pathB");
    expect(kase.history.map(h => h.element_id)).toContain("route");

    const items = await workItemsForCase(kase.case_id);
    expect(items).toHaveLength(1);
    expect(items[0].element_id).toBe("pathB");
  });

  test("AND split waits for all active branches before passing the join", async () => {
    const id = wfId("and-join");
    await registerWorkflow({
      id,
      version: "1.0.0",
      name: "AND join regression",
      elements: [
        { id: "start", type: "event", label: "Started" },
        { id: "split", type: "gateway", label: "Split", operator: "AND" },
        { id: "eventA", type: "event", label: "A ready" },
        { id: "eventB", type: "event", label: "B ready" },
        { id: "taskA", type: "function", label: "Task A", role: "qa" },
        { id: "taskB", type: "function", label: "Task B", role: "qa" },
        { id: "join", type: "gateway", label: "Join", operator: "AND" },
        { id: "end", type: "event", label: "Finished" },
      ],
      flow: [
        ["start", "split"],
        ["split", "eventA"],
        ["split", "eventB"],
        ["eventA", "taskA"],
        ["eventB", "taskB"],
        ["taskA", "join"],
        ["taskB", "join"],
        ["join", "end"],
      ],
    });

    const kase = await createCase(id, "and-join", {});
    expect(kase.status).toBe("running");
    expect(kase.position).toBe("split");
    expect(kase.active_branches?.map(b => b.element_id).sort()).toEqual(["taskA", "taskB"]);

    const items = (await workItemsForCase(kase.case_id)).sort((a, b) => String(a.element_id).localeCompare(String(b.element_id)));
    expect(items).toHaveLength(2);

    const first = await completeWorkItem(items[0].work_item_id, { first: true });
    expect(first.case?.status).toBe("running");
    expect(first.case?.active_branches?.filter(b => b.done)).toHaveLength(1);

    const second = await completeWorkItem(items[1].work_item_id, { second: true });
    expect(second.case?.status).toBe("done");
    expect(second.case?.position).toBe("end");
    expect(second.case?.active_branches).toBeUndefined();
  });

  test("manual intermediate event creates a deterministic wait and pauses the case", async () => {
    const id = wfId("manual-wait");
    await registerWorkflow({
      id,
      version: "1.0.0",
      name: "Manual wait regression",
      elements: [
        { id: "start", type: "event", label: "Started" },
        { id: "review", type: "function", label: "Review", role: "qa" },
        { id: "approved", type: "event", label: "Approved", role: "manager", trigger: { kind: "manual", deadline: "2099-01-01T00:00:00.000Z" } },
        { id: "publish", type: "function", label: "Publish", role: "qa" },
        { id: "end", type: "event", label: "Finished" },
      ],
      flow: [["start", "review"], ["review", "approved"], ["approved", "publish"], ["publish", "end"]],
    });

    const kase = await createCase(id, "manual-wait", {});
    const [item] = await workItemsForCase(kase.case_id);
    const paused = await completeWorkItem(item.work_item_id, { reviewed: true });

    expect(paused.case?.status).toBe("running");
    expect(paused.case?.position).toBe("approved");

    const waits = await loadActiveWaitsForCase(kase.case_id);
    expect(waits).toHaveLength(1);
    expect(waits[0].element_id).toBe("approved");
    expect(waits[0].trigger_kind).toBe("manual");
    expect(waits[0].assignee).toBe("manager");
  });

  test("event_fired idempotency suppresses duplicate deliveries", async () => {
    const id = wfId("idempotent-event");
    await registerWorkflow({
      id,
      version: "1.0.0",
      name: "Idempotent event regression",
      elements: [
        { id: "start", type: "event", label: "Started" },
        { id: "end", type: "event", label: "Finished" },
      ],
      flow: [["start", "end"]],
    });

    const key = `${RUN}-idem`;
    const first = await handleEventFired({ event_id: "start", process_id: id, instance_id: "new", idempotency_key: key });
    const second = await handleEventFired({ event_id: "start", process_id: id, instance_id: "new", idempotency_key: key });

    expect(first?.status).toBe("done");
    expect(second).toBeNull();
  });
});
