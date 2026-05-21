import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestRedis } from "./redis-test-utils";
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
const { config } = await import("../src/config");
const redis = createTestRedis();

const RUN = `act-wf-${Date.now()}`;
const ACT_WORKFLOW_ID = `${RUN}-direct`;
const HTTP_WORKFLOW_ID_PREFIX = `${RUN}-http`;
let actWorkItemId: string | null = null;
let wrapperWorkItemId: string | null = null;
const ACT_PERSON_ID = `${RUN}-person`;
const ACT_ROLE_ID = `${RUN}-role`;
const WRAPPER_ROLE_ID = `${RUN}-wrapper-role`;
const CANCEL_ROLE_ID = `${RUN}-cancel-role`;
const SSE_CANCEL_ROLE_ID = `${RUN}-sse-cancel-role`;
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
    "element.add",
    "element.update",
    "element.remove",
    "flow.add",
    "flow.remove",
    "trigger.set",
    "trigger.resolve",
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
    if (id.startsWith(HTTP_WORKFLOW_ID_PREFIX)) {
      await deleteCasesByProcess(id);
      await cleanupWorkflow(id);
    }
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
  await deleteRole(CANCEL_ROLE_ID).catch(() => {});
  await deleteRole(SSE_CANCEL_ROLE_ID).catch(() => {});
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

  test("lists active workflow cases and cancels/deletes a stuck case through API wrappers", async () => {
    const workflowId = `${HTTP_WORKFLOW_ID_PREFIX}-case-cancel`;
    const roleRes = await app.fetch(new Request("http://localhost/roles", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ role_id: CANCEL_ROLE_ID, name: "Cancel Role", assignees: ["act-test"], strategy: "manual" }),
    }));
    expect(roleRes.status).toBe(201);
    const workflowRes = await app.fetch(new Request("http://localhost/workflows", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        id: workflowId,
        name: "Cancelable case workflow",
        elements: [
          { id: "start", type: "event", label: "Start", trigger: { kind: "manual", manual_override: true } },
          { id: "review", type: "function", label: "Review", role: CANCEL_ROLE_ID },
          { id: "done", type: "event", label: "Done", trigger: { kind: "manual", manual_override: true } },
        ],
        flow: [["start", "review"], ["review", "done"]],
      }),
    }));
    expect(workflowRes.status).toBe(201);

    const deployRes = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ action: "workflow.deploy", category: "act", args: { id: workflowId } }),
    }));
    expect(deployRes.status).toBe(200);

    const startRes = await app.fetch(new Request("http://localhost/cases", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ process_id: workflowId, subject: "Stuck case", payload: { source: "issue-805-test" } }),
    }));
    const started = await startRes.json();
    expect(startRes.status).toBe(201);
    expect(started.status).toBe("running");

    const activeRes = await app.fetch(new Request(`http://localhost/workflows/${encodeURIComponent(workflowId)}/cases`, {
      method: "GET",
      headers: adminHeaders(),
    }));
    const activeBody = await activeRes.json();
    expect(activeRes.status).toBe(200);
    expect(activeBody.cases.map((kase: any) => kase.case_id)).toContain(started.case_id);

    const cancelRes = await app.fetch(new Request(`http://localhost/cases/${started.case_id}/cancel`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ reason: "operator cleanup" }),
    }));
    const cancelled = await cancelRes.json();
    expect(cancelRes.status).toBe(200);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.payload.__cancel_reason).toBe("operator cleanup");
    expect(cancelled.cancelled_work_items).toBeGreaterThanOrEqual(1);

    const cancelledItemsRes = await app.fetch(new Request(
      `http://localhost/workitems?process_id=${encodeURIComponent(workflowId)}&status=cancelled`,
      {
        method: "GET",
        headers: adminHeaders(),
      },
    ));
    const cancelledItems = await cancelledItemsRes.json();
    expect(cancelledItemsRes.status).toBe(200);
    expect(cancelledItems.items.length).toBeGreaterThanOrEqual(1);
    const staleWorkItemId = cancelledItems.items[0].work_item_id;

    const staleCompleteRes = await app.fetch(new Request(`http://localhost/workitems/${staleWorkItemId}/complete`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ output: { stale_completion: true } }),
    }));
    const staleComplete = await staleCompleteRes.json();
    expect(staleCompleteRes.status).toBe(409);
    expect(staleComplete.error).toContain("already cancelled");

    const cancelledAfterStaleCompleteRes = await app.fetch(new Request(`http://localhost/cases/${started.case_id}`, {
      method: "GET",
      headers: adminHeaders(),
    }));
    const cancelledAfterStaleComplete = await cancelledAfterStaleCompleteRes.json();
    expect(cancelledAfterStaleComplete.status).toBe("cancelled");
    expect(cancelledAfterStaleComplete.payload.stale_completion).toBeUndefined();

    const activeAfterCancel = await app.fetch(new Request(`http://localhost/workflows/${encodeURIComponent(workflowId)}/cases`, {
      method: "GET",
      headers: adminHeaders(),
    }));
    const activeAfterCancelBody = await activeAfterCancel.json();
    expect(activeAfterCancel.status).toBe(200);
    expect(activeAfterCancelBody.cases.map((kase: any) => kase.case_id)).not.toContain(started.case_id);

    const deleteRes = await app.fetch(new Request(`http://localhost/cases/${started.case_id}`, {
      method: "DELETE",
      headers: adminHeaders(),
    }));
    const deleted = await deleteRes.json();
    expect(deleteRes.status).toBe(200);
    expect(deleted).toMatchObject({ ok: true, deleted: true, case_id: started.case_id, process_id: workflowId });

    const missingRes = await app.fetch(new Request(`http://localhost/cases/${started.case_id}`, {
      method: "GET",
      headers: adminHeaders(),
    }));
    expect(missingRes.status).toBe(404);
  });

  test("case cancel pushes terminal SSE events without waiting for polling", async () => {
    const workflowId = `${HTTP_WORKFLOW_ID_PREFIX}-case-sse-cancel`;
    const roleRes = await app.fetch(new Request("http://localhost/roles", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ role_id: SSE_CANCEL_ROLE_ID, name: "SSE Cancel Role", assignees: ["act-test"], strategy: "manual" }),
    }));
    expect(roleRes.status).toBe(201);
    const workflowRes = await app.fetch(new Request("http://localhost/workflows", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        id: workflowId,
        name: "SSE cancel workflow",
        elements: [
          { id: "start", type: "event", label: "Start", trigger: { kind: "manual", manual_override: true } },
          { id: "review", type: "function", label: "Review", role: SSE_CANCEL_ROLE_ID },
          { id: "done", type: "event", label: "Done", trigger: { kind: "manual", manual_override: true } },
        ],
        flow: [["start", "review"], ["review", "done"]],
      }),
    }));
    expect(workflowRes.status).toBe(201);
    const deployRes = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ action: "workflow.deploy", category: "act", args: { id: workflowId } }),
    }));
    expect(deployRes.status).toBe(200);
    const startRes = await app.fetch(new Request("http://localhost/cases", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ process_id: workflowId, subject: "SSE stuck case", payload: {} }),
    }));
    const started = await startRes.json();
    expect(started.status).toBe("running");

    const streamRes = await app.fetch(new Request(`http://localhost/cases/${started.case_id}/stream`, {
      method: "GET",
      headers: adminHeaders(),
    }));
    expect(streamRes.status).toBe(200);
    const reader = streamRes.body!.getReader();
    const decoder = new TextDecoder();

    const readChunk = async (): Promise<string> => {
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out waiting for SSE")), 1500)),
      ]);
      return decoder.decode(result.value);
    };

    expect(await readChunk()).toContain("event: snapshot");

    const cancelRes = await app.fetch(new Request(`http://localhost/cases/${started.case_id}/cancel`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ reason: "sse cleanup" }),
    }));
    expect(cancelRes.status).toBe(200);

    let payload = "";
    for (let i = 0; i < 3 && !payload.includes("event: done"); i += 1) {
      payload += await readChunk();
    }
    expect(payload).toContain("\"status\":\"cancelled\"");
    expect(payload).toContain("event: done");
  });

  test("executes element.add directly with collision and schema validation", async () => {
    const workflowId = `${HTTP_WORKFLOW_ID_PREFIX}-element-add`;
    const createWorkflowRes = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        action: "workflow.create",
        category: "act",
        args: {
          id: workflowId,
          name: "Element add direct workflow",
          elements: [],
          flow: [],
          draft: true,
        },
      }),
    }));
    expect(createWorkflowRes.status).toBe(201);

    const addEvent = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        action: "element.add",
        category: "act",
        args: {
          workflow_id: workflowId,
          id: "e_start",
          type: "event",
          label: "Request received",
        },
      }),
    }));
    const addedEvent = await addEvent.json();
    expect(addEvent.status).toBe(200);
    expect(addedEvent.ok).toBe(true);
    expect(addedEvent.data.added_element).toEqual({
      id: "e_start",
      type: "event",
      label: "Request received",
    });
    expect(addedEvent.data.lifecycle_state).toBe("draft");

    const addFunction = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        action: "element.add",
        category: "act",
        args: {
          workflow_id: workflowId,
          id: "f_review",
          type: "function",
          label: "Review request",
          role: "reviewer",
        },
      }),
    }));
    expect(addFunction.status).toBe(200);

    const addGateway = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        action: "element.add",
        category: "act",
        args: {
          workflow_id: workflowId,
          id: "g_decide",
          type: "gateway",
          label: "Decide path",
        },
      }),
    }));
    const addedGateway = await addGateway.json();
    expect(addGateway.status).toBe(200);
    expect(addedGateway.data.added_element.operator).toBe("XOR");
    expect(addedGateway.data.elements.map((el: any) => el.id)).toEqual(["e_start", "f_review", "g_decide"]);

    const duplicate = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        action: "element.add",
        category: "act",
        args: {
          workflow_id: workflowId,
          id: "e_start",
          type: "event",
          label: "Duplicate start",
        },
      }),
    }));
    const duplicateBody = await duplicate.json();
    expect(duplicate.status).toBe(409);
    expect(duplicateBody.error).toBe("Element ID already exists");
    expect(duplicateBody.data).toMatchObject({
      code: "ELEMENT_ID_EXISTS",
      workflow_id: workflowId,
      element_id: "e_start",
    });

    const invalidPayload = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        action: "element.add",
        category: "act",
        args: {
          workflow_id: workflowId,
          id: "f_missing_role",
          type: "function",
          label: "Missing role",
        },
      }),
    }));
    const invalidPayloadBody = await invalidPayload.json();
    expect(invalidPayload.status).toBe(400);
    expect(invalidPayloadBody.error).toBe("Invalid element schema");
    expect(invalidPayloadBody.data.details).toContain("function elements require role");
  });

  test("validates element.add against non-draft workflow schema before persistence", async () => {
    const workflowId = `${HTTP_WORKFLOW_ID_PREFIX}-element-validated`;
    const createWorkflowRes = await app.fetch(new Request("http://localhost/workflows", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        id: workflowId,
        name: "Element add validated workflow",
        elements: [
          { id: "start", type: "event", label: "Start" },
          { id: "review", type: "function", label: "Review", role: "reviewer" },
          { id: "done", type: "event", label: "Done" },
        ],
        flow: [["start", "review"], ["review", "done"]],
      }),
    }));
    expect(createWorkflowRes.status).toBe(201);

    const invalidAddition = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        action: "element.add",
        category: "act",
        args: {
          workflow_id: workflowId,
          id: "f_orphan",
          type: "function",
          label: "Orphan task",
          role: "reviewer",
        },
      }),
    }));
    const invalidBody = await invalidAddition.json();
    expect(invalidAddition.status).toBe(422);
    expect(invalidBody.error).toBe("Validation failed");
    expect(invalidBody.data).toMatchObject({
      code: "WORKFLOW_VALIDATION_FAILED",
      workflow_id: workflowId,
      element_id: "f_orphan",
    });

    const validAddition = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        action: "element.add",
        category: "act",
        args: {
          workflow_id: workflowId,
          id: "followup",
          type: "event",
          label: "Follow-up complete",
        },
      }),
    }));
    const validBody = await validAddition.json();
    expect(validAddition.status).toBe(200);
    expect(validBody.data.lifecycle_state).toBe("validated");
    expect(validBody.data.last_deploy).toBeUndefined();
    expect(validBody.data.elements.some((el: any) => el.id === "f_orphan")).toBe(false);
    expect(validBody.data.elements.some((el: any) => el.id === "followup")).toBe(true);
  });

  test("preserves concurrent element.add mutations on the same workflow", async () => {
    const workflowId = `${HTTP_WORKFLOW_ID_PREFIX}-element-add-concurrent`;
    const createWorkflowRes = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        action: "workflow.create",
        category: "act",
        args: {
          id: workflowId,
          name: "Concurrent element add workflow",
          elements: [],
          flow: [],
          draft: true,
        },
      }),
    }));
    expect(createWorkflowRes.status).toBe(201);

    const { executeActionDirect } = await import("../src/action-executor");
    const [first, second] = await Promise.all([
      executeActionDirect("element.add", {
        workflow_id: workflowId,
        id: "e_parallel_a",
        type: "event",
        label: "Parallel A",
      }),
      executeActionDirect("element.add", {
        workflow_id: workflowId,
        id: "e_parallel_b",
        type: "event",
        label: "Parallel B",
      }),
    ]);

    expect([first?.status, second?.status].sort()).toEqual([200, 200]);
    const persisted = await executeActionDirect("workflow.get", { id: workflowId });
    expect(persisted?.status).toBe(200);
    const elementIds = ((persisted?.data as any).elements ?? []).map((el: any) => el.id).sort();
    expect(elementIds).toEqual(["e_parallel_a", "e_parallel_b"]);
  });

  test("executes flow.add and flow.remove directly with duplicate and condition handling", async () => {
    const workflowId = `${HTTP_WORKFLOW_ID_PREFIX}-flow-direct`;
    const createWorkflowRes = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        action: "workflow.create",
        category: "act",
        args: {
          id: workflowId,
          name: "Flow direct workflow",
          elements: [
            { id: "start", type: "event", label: "Start" },
            { id: "review", type: "function", label: "Review", role: "reviewer" },
            { id: "done", type: "event", label: "Done" },
          ],
          flow: [],
          draft: true,
        },
      }),
    }));
    expect(createWorkflowRes.status).toBe(201);

    const addPlain = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        action: "flow.add",
        category: "act",
        args: { workflow_id: workflowId, from: "start", to: "review" },
      }),
    }));
    const addPlainBody = await addPlain.json();
    expect(addPlain.status).toBe(200);
    expect(addPlainBody.data.added_edge).toEqual(["start", "review"]);

    const addConditional = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        action: "flow.add",
        category: "act",
        args: { workflow_id: workflowId, from: "review", to: "done", condition: "payload.approved === true" },
      }),
    }));
    const addConditionalBody = await addConditional.json();
    expect(addConditional.status).toBe(200);
    expect(addConditionalBody.data.added_edge).toEqual(["review", "done", "payload.approved === true"]);
    expect(addConditionalBody.data.flow).toEqual([
      ["start", "review"],
      ["review", "done", "payload.approved === true"],
    ]);

    const duplicate = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        action: "flow.add",
        category: "act",
        args: { workflow_id: workflowId, from: "review", to: "done", condition: "payload.retry === true" },
      }),
    }));
    const duplicateBody = await duplicate.json();
    expect(duplicate.status).toBe(409);
    expect(duplicateBody.data).toMatchObject({
      code: "FLOW_EDGE_EXISTS",
      workflow_id: workflowId,
      from: "review",
      to: "done",
    });

    const remove = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        action: "flow.remove",
        category: "act",
        args: { workflow_id: workflowId, from: "review", to: "done" },
      }),
    }));
    const removeBody = await remove.json();
    expect(remove.status).toBe(200);
    expect(removeBody.data.removed_edge).toEqual(["review", "done", "payload.approved === true"]);
    expect(removeBody.data.flow).toEqual([["start", "review"]]);

    const missing = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        action: "flow.remove",
        category: "act",
        args: { workflow_id: workflowId, from: "review", to: "done" },
      }),
    }));
    const missingBody = await missing.json();
    expect(missing.status).toBe(404);
    expect(missingBody.data.code).toBe("FLOW_EDGE_NOT_FOUND");
  });

  test("validates flow mutations against non-draft workflow graph before persistence", async () => {
    const workflowId = `${HTTP_WORKFLOW_ID_PREFIX}-flow-validated`;
    const createWorkflowRes = await app.fetch(new Request("http://localhost/workflows", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        id: workflowId,
        name: "Flow validated workflow",
        elements: [
          { id: "start", type: "event", label: "Start" },
          { id: "review", type: "function", label: "Review", role: "reviewer" },
          { id: "done", type: "event", label: "Done" },
        ],
        flow: [["start", "review"], ["review", "done"]],
      }),
    }));
    expect(createWorkflowRes.status).toBe(201);

    const invalidAdd = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        action: "flow.add",
        category: "act",
        args: { workflow_id: workflowId, from: "start", to: "done" },
      }),
    }));
    const invalidAddBody = await invalidAdd.json();
    expect(invalidAdd.status).toBe(422);
    expect(invalidAddBody.data).toMatchObject({
      code: "WORKFLOW_VALIDATION_FAILED",
      workflow_id: workflowId,
      edge: { from: "start", to: "done" },
    });

    const afterInvalidAdd = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ action: "workflow.get", category: "inspect", args: { id: workflowId } }),
    }));
    const afterInvalidAddBody = await afterInvalidAdd.json();
    expect(afterInvalidAddBody.data.flow).toEqual([["start", "review"], ["review", "done"]]);

    const invalidRemove = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        action: "flow.remove",
        category: "act",
        args: { workflow_id: workflowId, from: "review", to: "done" },
      }),
    }));
    const invalidRemoveBody = await invalidRemove.json();
    expect(invalidRemove.status).toBe(422);
    expect(invalidRemoveBody.data).toMatchObject({
      code: "WORKFLOW_VALIDATION_FAILED",
      workflow_id: workflowId,
      edge: { from: "review", to: "done" },
    });

    const missingEndpoint = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        action: "flow.add",
        category: "act",
        args: { workflow_id: workflowId, from: "missing", to: "done" },
      }),
    }));
    const missingEndpointBody = await missingEndpoint.json();
    expect(missingEndpoint.status).toBe(400);
    expect(missingEndpointBody.data).toMatchObject({
      code: "INVALID_FLOW_ENDPOINTS",
      workflow_id: workflowId,
    });
  });

  test("executes element.update and element.remove directly with validation and version guards", async () => {
    const workflowId = `${HTTP_WORKFLOW_ID_PREFIX}-element-update-remove`;
    const createWorkflowRes = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        action: "workflow.create",
        category: "act",
        args: {
          id: workflowId,
          name: "Element update remove workflow",
          elements: [
            { id: "start", type: "event", label: "Start" },
            { id: "review", type: "function", label: "Review", role: "reviewer" },
            { id: "done", type: "event", label: "Done" },
          ],
          flow: [["start", "review"], ["review", "done"]],
          draft: true,
        },
      }),
    }));
    expect(createWorkflowRes.status).toBe(201);

    const update = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        action: "element.update",
        category: "act",
        args: {
          workflow_id: workflowId,
          id: "review",
          label: "Review request carefully",
          role: "senior_reviewer",
          expected_edit_version: 1,
        },
      }),
    }));
    const updateBody = await update.json();
    expect(update.status).toBe(200);
    expect(updateBody.data.updated_element).toMatchObject({
      id: "review",
      label: "Review request carefully",
      role: "senior_reviewer",
    });
    expect(updateBody.data.edit_version).toBe(2);

    const stale = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        action: "element.update",
        category: "act",
        args: {
          workflow_id: workflowId,
          id: "review",
          label: "Stale update",
          expected_edit_version: 1,
        },
      }),
    }));
    const staleBody = await stale.json();
    expect(stale.status).toBe(409);
    expect(staleBody.data).toMatchObject({
      code: "WORKFLOW_UPDATE_CONFLICT",
      workflow_id: workflowId,
      details: { expected_edit_version: 1, actual_edit_version: 2 },
    });

    const remove = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        action: "element.remove",
        category: "act",
        args: { workflow_id: workflowId, id: "review", expected_edit_version: 2 },
      }),
    }));
    const removeBody = await remove.json();
    expect(remove.status).toBe(200);
    expect(removeBody.data.removed_element.id).toBe("review");
    expect(removeBody.data.removed_edges).toEqual([["start", "review"], ["review", "done"]]);
    expect(removeBody.data.elements.map((el: any) => el.id)).toEqual(["start", "done"]);
    expect(removeBody.data.flow).toEqual([]);
  });

  test("executes trigger.set and trigger.resolve directly on event elements", async () => {
    const workflowId = `${HTTP_WORKFLOW_ID_PREFIX}-trigger-direct`;
    const createWorkflowRes = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        action: "workflow.create",
        category: "act",
        args: {
          id: workflowId,
          name: "Trigger direct workflow",
          elements: [
            { id: "start", type: "event", label: "Start" },
            { id: "review", type: "function", label: "Review", role: "reviewer" },
          ],
          flow: [["start", "review"]],
          draft: true,
        },
      }),
    }));
    expect(createWorkflowRes.status).toBe(201);

    const setTrigger = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        action: "trigger.set",
        category: "act",
        args: {
          workflow_id: workflowId,
          element_id: "start",
          kind: "timer",
          config: { cron: "0 9 * * *", confidence: 1 },
          expected_edit_version: 1,
        },
      }),
    }));
    const setBody = await setTrigger.json();
    expect(setTrigger.status).toBe(200);
    expect(setBody.data.trigger).toMatchObject({ kind: "timer", cron: "0 9 * * *", confidence: 1 });
    expect(setBody.data.updated_element.trigger).toMatchObject({ kind: "timer", cron: "0 9 * * *" });

    const invalidTarget = await app.fetch(new Request("http://localhost/act", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        action: "trigger.set",
        category: "act",
        args: {
          workflow_id: workflowId,
          element_id: "review",
          kind: "manual",
          config: { manual_override: true },
        },
      }),
    }));
    const invalidTargetBody = await invalidTarget.json();
    expect(invalidTarget.status).toBe(400);
    expect(invalidTargetBody.data.code).toBe("INVALID_TRIGGER_TARGET");

    const oldAnthropicKey = config.llm.anthropicApiKey;
    config.llm.anthropicApiKey = "";
    try {
      const resolved = await app.fetch(new Request("http://localhost/act", {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({
          action: "trigger.resolve",
          category: "act",
          args: {
            workflow_id: workflowId,
            element_id: "start",
            expected_edit_version: 2,
          },
        }),
      }));
      const resolvedBody = await resolved.json();
      expect(resolved.status).toBe(200);
      expect(resolvedBody.data.trigger).toMatchObject({ kind: "ambiguous", confidence: 0 });
      expect(resolvedBody.data.updated_element.trigger).toMatchObject({ kind: "ambiguous" });
    } finally {
      config.llm.anthropicApiKey = oldAnthropicKey;
    }
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
