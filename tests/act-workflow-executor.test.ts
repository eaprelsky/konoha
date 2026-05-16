import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import Redis from "ioredis";
import { AUDIT_STREAM, AUTONOMY_KEY } from "../src/assistant-actions";
import { unregisterAgent } from "../src/redis";
import { deleteCasesByProcess } from "../src/runtime/cases/crud";
import { deleteReminder } from "../src/runtime/reminders";
import { deleteRole } from "../src/runtime/roles";
import { pgDeleteWorkflow, pgDeleteWorkItem } from "../src/storage/pg";

process.env.KONOHA_PORT = "0";
process.env.ANTHROPIC_API_KEY ||= "test-anthropic-key";

const TEST_ADMIN_TOKEN = process.env.KONOHA_TOKEN || "test-admin-token-preload";
const { app } = await import("../core/src/server");
const redis = new Redis({ host: "127.0.0.1", port: 6379, db: parseInt(process.env.REDIS_DB ?? "0") });

const RUN = `act-wf-${Date.now()}`;
const ACT_WORKFLOW_ID = `${RUN}-direct`;
const HTTP_WORKFLOW_ID_PREFIX = `${RUN}-http`;
let actWorkItemId: string | null = null;
let wrapperWorkItemId: string | null = null;
const ACT_PERSON_ID = `${RUN}-person`;
const ACT_ROLE_ID = `${RUN}-role`;
const WRAPPER_ROLE_ID = `${RUN}-wrapper-role`;
let actReminderId: string | null = null;
let wrapperReminderId: string | null = null;
const RBAC_AGENT_ID = `${RUN}-rbac-agent`;
const savedAutonomy: Record<string, string | null> = {};

function adminHeaders() {
  return { Authorization: `Bearer ${TEST_ADMIN_TOKEN}`, "Content-Type": "application/json" };
}

async function cleanupWorkflow(id: string) {
  await redis.srem("konoha:workflow:index", id);
  await redis.del(`workflow:${id}`);
  await pgDeleteWorkflow(id);
}

async function readAuditBySession(sessionId: string): Promise<Record<string, string>[]> {
  const raw = await redis.xrevrange(AUDIT_STREAM, "+", "-", "COUNT", 50);
  return raw
    .map(([, fields]) => {
      const entry: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) entry[fields[i]] = fields[i + 1];
      return entry;
    })
    .filter(entry => entry.session_id === sessionId);
}

beforeAll(async () => {
  for (const action of [
    "workflow.create",
    "workflow.update",
    "workflow.delete",
    "workitem.create",
    "workitem.update",
    "workitem.cancel",
  ]) {
    savedAutonomy[action] = await redis.hget(AUTONOMY_KEY, action);
    await redis.hset(AUTONOMY_KEY, action, "auto");
  }
});

afterAll(async () => {
  for (const [action, value] of Object.entries(savedAutonomy)) {
    if (value == null) await redis.hdel(AUTONOMY_KEY, action);
    else await redis.hset(AUTONOMY_KEY, action, value);
  }

  await cleanupWorkflow(ACT_WORKFLOW_ID);
  const ids = await redis.smembers("konoha:workflow:index");
  for (const id of ids) {
    if (id.startsWith(HTTP_WORKFLOW_ID_PREFIX)) await cleanupWorkflow(id);
  }
  await deleteCasesByProcess(`${HTTP_WORKFLOW_ID_PREFIX}-case`);
  if (actWorkItemId) {
    await redis.del(`workitem:${actWorkItemId}`);
    await redis.srem("konoha:workitems:assignee:act-test", actWorkItemId);
    await redis.srem("konoha:workitems:status:pending", actWorkItemId);
    await redis.srem("konoha:workitems:status:cancelled", actWorkItemId);
    await redis.zrem("konoha:workitems:all", actWorkItemId);
    await pgDeleteWorkItem(actWorkItemId);
  }
  if (wrapperWorkItemId) {
    await redis.del(`workitem:${wrapperWorkItemId}`);
    await redis.srem("konoha:workitems:assignee:act-wrapper", wrapperWorkItemId);
    await redis.srem("konoha:workitems:status:pending", wrapperWorkItemId);
    await redis.srem("konoha:workitems:status:cancelled", wrapperWorkItemId);
    await redis.zrem("konoha:workitems:all", wrapperWorkItemId);
    await pgDeleteWorkItem(wrapperWorkItemId);
  }
  await deleteRole(ACT_ROLE_ID).catch(() => {});
  await deleteRole(WRAPPER_ROLE_ID).catch(() => {});
  if (actReminderId) await deleteReminder(actReminderId).catch(() => {});
  if (wrapperReminderId) await deleteReminder(wrapperReminderId).catch(() => {});
  await redis.hdel("people:custom", ACT_PERSON_ID);
  await unregisterAgent(RBAC_AGENT_ID, true).catch(() => {});
  redis.disconnect();
  delete process.env.KONOHA_PORT;
});

describe("/act workflow executor", () => {
  test("executes workflow.create directly through the action envelope", async () => {
    const res = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        action: "workflow.create",
        category: "act",
        args: {
          id: ACT_WORKFLOW_ID,
          name: "Action executor workflow",
          elements: [],
          flow: [],
          draft: true,
        },
        meta: { session_id: `${RUN}-create-test` },
      }),
    }));

    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.ok).toBe(true);
    expect(body.action).toBe("workflow.create");
    expect(body.data.id).toBe(ACT_WORKFLOW_ID);
    expect(body.data.normalized).toBe(false);
  });

  test("executes workflow.update directly through the action envelope", async () => {
    const res = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        action: "workflow.update",
        category: "act",
        args: {
          id: ACT_WORKFLOW_ID,
          name: "Updated action executor workflow",
          draft: true,
        },
        meta: { session_id: `${RUN}-update-test` },
      }),
    }));

    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.action).toBe("workflow.update");
    expect(body.data.name).toBe("Updated action executor workflow");
  });

  test("keeps legacy /workflows create as a compatibility wrapper with defaults", async () => {
    const id = `${HTTP_WORKFLOW_ID_PREFIX}-wrapper`;
    const res = await app.fetch(new Request("http://localhost/workflows?draft=true", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ id, name: "HTTP wrapper workflow" }),
    }));

    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.id).toBe(id);
    expect(body.elements).toEqual([]);
    expect(body.flow).toEqual([]);
  });

  test("keeps legacy /cases start as a compatibility wrapper around case.start", async () => {
    const workflowId = `${HTTP_WORKFLOW_ID_PREFIX}-case`;
    const workflowRes = await app.fetch(new Request("http://localhost/workflows", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        id: workflowId,
        name: "HTTP case wrapper workflow",
        elements: [{ id: "start", type: "event", label: "Start", trigger: { kind: "manual", manual_override: true } }],
        flow: [],
      }),
    }));
    expect(workflowRes.status).toBe(201);

    const deployRes = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        action: "workflow.deploy",
        category: "act",
        args: { id: workflowId },
      }),
    }));
    expect(deployRes.status).toBe(200);

    const res = await app.fetch(new Request("http://localhost/cases", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        process_id: workflowId,
        subject: "HTTP wrapper case",
        payload: { source: "act-workflow-executor.test" },
      }),
    }));

    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.process_id).toBe(workflowId);
    expect(body.subject).toBe("HTTP wrapper case");
  });

  test("executes case.list directly through the action envelope", async () => {
    const res = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        action: "case.list",
        category: "inspect",
        args: { process_id: ACT_WORKFLOW_ID, limit: 1 },
        meta: { session_id: `${RUN}-case-list-test` },
      }),
    }));

    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.action).toBe("case.list");
    expect(Array.isArray(body.data.cases)).toBe(true);
  });

  test("executes workitem create/update/cancel directly through the action envelope", async () => {
    const createRes = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        action: "workitem.create",
        category: "act",
        args: {
          label: "Action executor work item",
          assignee: "act-test",
          input: { source: "act-workflow-executor.test" },
        },
        meta: { session_id: `${RUN}-workitem-create-test` },
      }),
    }));

    const created = await createRes.json();
    expect(createRes.status).toBe(201);
    expect(created.ok).toBe(true);
    expect(created.data.assignee).toBe("act-test");
    actWorkItemId = created.data.work_item_id;

    const updateRes = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        action: "workitem.update",
        category: "act",
        args: { id: actWorkItemId, deadline: "2030-01-01T00:00:00.000Z" },
        meta: { session_id: `${RUN}-workitem-update-test` },
      }),
    }));
    const updated = await updateRes.json();
    expect(updateRes.status).toBe(200);
    expect(updated.data.deadline).toBe("2030-01-01T00:00:00.000Z");

    const cancelRes = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        action: "workitem.cancel",
        category: "act",
        args: { id: actWorkItemId },
        meta: { session_id: `${RUN}-workitem-cancel-test` },
      }),
    }));
    const cancelled = await cancelRes.json();
    expect(cancelRes.status).toBe(200);
    expect(cancelled.data.status).toBe("cancelled");
  });

  test("keeps legacy /workitems mutations as compatibility wrappers around workitem actions", async () => {
    const createRes = await app.fetch(new Request("http://localhost/workitems", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        label: "HTTP wrapper work item",
        assignee: "act-wrapper",
        input: { source: "legacy-wrapper" },
        process_id: ACT_WORKFLOW_ID,
      }),
    }));

    const created = await createRes.json();
    expect(createRes.status).toBe(201);
    expect(created.assignee).toBe("act-wrapper");
    expect(created.process_id).toBe(ACT_WORKFLOW_ID);
    wrapperWorkItemId = created.work_item_id;

    const updateRes = await app.fetch(new Request(`http://localhost/workitems/${wrapperWorkItemId}`, {
      method: "PATCH",
      headers: adminHeaders(),
      body: JSON.stringify({
        label: "Updated HTTP wrapper work item",
        deadline: "2030-02-01T00:00:00.000Z",
      }),
    }));
    const updated = await updateRes.json();
    expect(updateRes.status).toBe(200);
    expect(updated.label).toBe("Updated HTTP wrapper work item");
    expect(updated.deadline).toBe("2030-02-01T00:00:00.000Z");

    const deleteRes = await app.fetch(new Request(`http://localhost/workitems/${wrapperWorkItemId}`, {
      method: "DELETE",
      headers: adminHeaders(),
    }));
    const cancelled = await deleteRes.json();
    expect(deleteRes.status).toBe(200);
    expect(cancelled.status).toBe("cancelled");
  });

  test("executes role create/update/delete directly through the action envelope", async () => {
    const createRes = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        action: "role.create",
        category: "act",
        args: {
          role_id: ACT_ROLE_ID,
          name: "Action Role",
          assignees: ["naruto"],
          strategy: "manual",
        },
        meta: { session_id: `${RUN}-role-create-test` },
      }),
    }));
    const created = await createRes.json();
    expect(createRes.status).toBe(201);
    expect(created.ok).toBe(true);
    expect(created.data.role_id).toBe(ACT_ROLE_ID);
    expect(created.data.assignees).toEqual(["naruto"]);

    const updateRes = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        action: "role.update",
        category: "act",
        args: { id: ACT_ROLE_ID, name: "Updated Action Role", assignees: ["sasuke"] },
        meta: { session_id: `${RUN}-role-update-test` },
      }),
    }));
    const updated = await updateRes.json();
    expect(updateRes.status).toBe(200);
    expect(updated.data.name).toBe("Updated Action Role");
    expect(updated.data.assignees).toEqual(["sasuke"]);

    const deleteRes = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        action: "role.delete",
        category: "act",
        args: { id: ACT_ROLE_ID },
        meta: { session_id: `${RUN}-role-delete-test` },
      }),
    }));
    const deleted = await deleteRes.json();
    expect(deleteRes.status).toBe(200);
    expect(deleted.data.ok).toBe(true);
  });

  test("keeps legacy /roles mutations as compatibility wrappers around role actions", async () => {
    const createRes = await app.fetch(new Request("http://localhost/roles", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        role_id: WRAPPER_ROLE_ID,
        name: "HTTP wrapper role",
        assignees: ["naruto"],
        strategy: "manual",
      }),
    }));
    const created = await createRes.json();
    expect(createRes.status).toBe(201);
    expect(created.role_id).toBe(WRAPPER_ROLE_ID);
    expect(created.assignees).toEqual(["naruto"]);

    const updateRes = await app.fetch(new Request(`http://localhost/roles/${WRAPPER_ROLE_ID}`, {
      method: "PATCH",
      headers: adminHeaders(),
      body: JSON.stringify({ name: "Updated HTTP wrapper role", assignees: ["sasuke"] }),
    }));
    const updated = await updateRes.json();
    expect(updateRes.status).toBe(200);
    expect(updated.name).toBe("Updated HTTP wrapper role");
    expect(updated.assignees).toEqual(["sasuke"]);

    const deleteRes = await app.fetch(new Request(`http://localhost/roles/${WRAPPER_ROLE_ID}`, {
      method: "DELETE",
      headers: adminHeaders(),
    }));
    const deleted = await deleteRes.json();
    expect(deleteRes.status).toBe(200);
    expect(deleted.ok).toBe(true);
  });

  test("executes reminder create/update/delete directly through the action envelope", async () => {
    const createRes = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        action: "reminder.create",
        category: "act",
        args: {
          recipient: "naruto",
          message: "Action reminder",
          scheduled_at: "2030-03-01T00:00:00.000Z",
          channel: "gui",
          process_id: ACT_WORKFLOW_ID,
        },
        meta: { session_id: `${RUN}-reminder-create-test` },
      }),
    }));
    const created = await createRes.json();
    expect(createRes.status).toBe(201);
    expect(created.ok).toBe(true);
    expect(created.data.recipient).toBe("naruto");
    expect(created.data.process_id).toBe(ACT_WORKFLOW_ID);
    actReminderId = created.data.reminder_id;

    const updateRes = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        action: "reminder.update_status",
        category: "act",
        args: { id: actReminderId, status: "sent" },
        meta: { session_id: `${RUN}-reminder-update-test` },
      }),
    }));
    const updated = await updateRes.json();
    expect(updateRes.status).toBe(200);
    expect(updated.data.status).toBe("sent");

    const deleteRes = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        action: "reminder.delete",
        category: "act",
        args: { id: actReminderId },
        meta: { session_id: `${RUN}-reminder-delete-test` },
      }),
    }));
    const deleted = await deleteRes.json();
    expect(deleteRes.status).toBe(200);
    expect(deleted.data.ok).toBe(true);
  });

  test("keeps legacy /reminders mutations as compatibility wrappers around reminder actions", async () => {
    const createRes = await app.fetch(new Request("http://localhost/reminders", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        recipient: "sasuke",
        message: "HTTP wrapper reminder",
        scheduled_at: "2030-04-01T00:00:00.000Z",
        channel: "gui",
        process_id: ACT_WORKFLOW_ID,
      }),
    }));
    const created = await createRes.json();
    expect(createRes.status).toBe(201);
    expect(created.recipient).toBe("sasuke");
    expect(created.process_id).toBe(ACT_WORKFLOW_ID);
    wrapperReminderId = created.reminder_id;

    const updateRes = await app.fetch(new Request(`http://localhost/reminders/${wrapperReminderId}/status`, {
      method: "PATCH",
      headers: adminHeaders(),
      body: JSON.stringify({ status: "sent" }),
    }));
    const updated = await updateRes.json();
    expect(updateRes.status).toBe(200);
    expect(updated.status).toBe("sent");

    const deleteRes = await app.fetch(new Request(`http://localhost/reminders/${wrapperReminderId}`, {
      method: "DELETE",
      headers: adminHeaders(),
    }));
    const deleted = await deleteRes.json();
    expect(deleteRes.status).toBe(200);
    expect(deleted.ok).toBe(true);
  });

  test("routes agent lifecycle wrappers through direct actions without losing 404 semantics", async () => {
    const missingId = `${RUN}-missing-agent`;
    const { executeActionDirect } = await import("../src/action-executor");

    const direct = await executeActionDirect("agent.start", { id: missingId });
    expect(direct?.status).toBe(404);
    expect((direct?.data as any).error).toBe("Agent not found");

    const wrapper = await app.fetch(new Request(`http://localhost/agents/${missingId}/start`, {
      method: "POST",
      headers: adminHeaders(),
    }));
    const body = await wrapper.json();
    expect(wrapper.status).toBe(404);
    expect(body.error).toBe("Agent not found");
  });

  test("executes person actions directly through the action envelope", async () => {
    const createRes = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        action: "person.upsert",
        category: "act",
        args: { id: ACT_PERSON_ID, name: "Act Person", tg_id: 9876501, position: "QA" },
        meta: { session_id: `${RUN}-person-upsert-test` },
      }),
    }));
    const created = await createRes.json();
    expect(createRes.status).toBe(201);
    expect(created.ok).toBe(true);
    expect(created.data.id).toBe(ACT_PERSON_ID);

    const listRes = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        action: "person.list",
        category: "inspect",
        args: {},
      }),
    }));
    const listed = await listRes.json();
    expect(listRes.status).toBe(200);
    expect(listed.data.some((p: any) => p.id === ACT_PERSON_ID)).toBe(true);

    const deleteRes = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        action: "person.delete",
        category: "act",
        args: { id: ACT_PERSON_ID },
        meta: { session_id: `${RUN}-person-delete-test` },
      }),
    }));
    const deleted = await deleteRes.json();
    expect(deleteRes.status).toBe(200);
    expect(deleted.data.ok).toBe(true);
  });

  test("agent token cannot mutate admin-only access/person actions through /act", async () => {
    const reg = await app.fetch(new Request("http://localhost/agents/register", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ id: RBAC_AGENT_ID, name: "Act RBAC Agent" }),
    }));
    const agent = await reg.json();

    const res = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers: { Authorization: `Bearer ${agent.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "access.upsert_user",
        category: "act",
        args: { name: "Blocked", telegram_id: 123456789 },
      }),
    }));

    expect(res.status).toBe(403);
  });

  test("agent token cannot use /act to bypass workflow/case admin boundaries", async () => {
    const reg = await app.fetch(new Request("http://localhost/agents/register", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ id: RBAC_AGENT_ID, name: "Act RBAC Agent" }),
    }));
    const agent = await reg.json();
    const headers = { Authorization: `Bearer ${agent.token}`, "Content-Type": "application/json" };
    const deniedSession = `${RUN}-workflow-denied`;

    const workflowCreate = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "workflow.create",
        category: "act",
        args: { id: `${RUN}-blocked`, name: "Blocked", elements: [], flow: [], draft: true },
        meta: { session_id: deniedSession },
      }),
    }));
    expect(workflowCreate.status).toBe(403);

    const audit = await readAuditBySession(deniedSession);
    expect(audit).toHaveLength(1);
    expect(audit[0].action_type).toBe("workflow.create");
    expect(audit[0].result).toBe("blocked");
    expect(audit[0].agent_chain).toBe(`api:agent:${RBAC_AGENT_ID}`);
    expect(audit[0].args_summary).toContain(`${RUN}-blocked`);
    expect(audit[0].error).toBe("Forbidden: admin token required");

    const caseList = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "case.list",
        category: "inspect",
        args: {},
      }),
    }));
    expect(caseList.status).toBe(403);
  });
});
