import { Hono, type Context } from "hono";
import { requireAdmin } from "../../../../src/middleware/auth";
import type { HonoEnv, CallerInfo } from "../../../../src/types";
import { redis } from "../../../../src/redis";
import {
  getCase,
  listWorkItems,
  listCases,
  deleteCasesByProcess,
  getWorkItem,
  purgeAllWorkItems,
  recoverStuckWorkItems,
  type WorkItemStatus,
  type CaseStatus,
  type ReminderStatus,
} from "../../../../src/runtime";
import {
  listEventWaits,
  loadEventWait,
  resolveEventWaitForNode,
  type EventWaitStatus,
} from "../../../../src/runtime/event-waits";
import { getWorkflow } from "../../../../src/workflow-loader";
import { emitEvent } from "../../../../src/runtime/event-log";
import { executeActionDirect, type ActionExecution } from "../../../../src/action-executor";

// Cases router — mounted at /cases
export const casesRouter = new Hono<HonoEnv>();

type RouteContext = Context<HonoEnv>;

function caller(c: { get: (key: "caller") => CallerInfo }): CallerInfo {
  return c.get("caller");
}

async function requireWorkItemOwnerOrAdmin(c: RouteContext, workItemId: string): Promise<Response | null> {
  const current = caller(c);
  const wi = await getWorkItem(workItemId);
  if (!wi) return c.json({ error: "Work item not found" }, 404);
  if (!current.isAdmin && wi.assignee !== current.agentId) {
    return c.json({ error: "Forbidden: work item is assigned to another agent" }, 403);
  }
  return null;
}

function authorizedAssignee(c: RouteContext, requested?: string): string | undefined | Response {
  const current = caller(c);
  if (current.isAdmin) return requested;
  if (requested && requested !== current.agentId) {
    return c.json({ error: "Forbidden: can only list your own work items" }, 403);
  }
  return current.agentId ?? undefined;
}

function actionJson(c: RouteContext, result: ActionExecution): Response {
  return c.json(result.data as any, result.status as any);
}

casesRouter.get("/", async (c) => {
  const status = (c.req.query("status") || undefined) as CaseStatus | undefined;
  const process_id = c.req.query("process_id") || undefined;
  const after = c.req.query("after") || undefined;
  const before = c.req.query("before") || undefined;
  const limit = Math.min(parseInt(c.req.query("limit") || "50"), 2000);
  const offset = parseInt(c.req.query("offset") || "0");
  const result = await listCases({ status, process_id, after, before, limit, offset });
  return c.json(result);
});

casesRouter.post("/", requireAdmin, async (c) => {
  const body = await c.req.json();
  const { process_id, subject, payload = {}, start_node, admin_override } = body;
  if (!process_id || !subject) return c.json({ error: "process_id and subject required" }, 400);
  const result = await executeActionDirect("case.start", { process_id, subject, payload, start_node, admin_override });
  return actionJson(c, result!);
});

casesRouter.get("/:id", async (c) => {
  const id = c.req.param("id");
  const kase = await getCase(id);
  if (!kase) return c.json({ error: "Case not found" }, 404);
  return c.json(kase);
});

casesRouter.post("/:id/close", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const result = await executeActionDirect("case.close", { id });
  return actionJson(c, result!);
});

// DELETE /cases?process_id=... — bulk delete cases for a process (admin cleanup)
casesRouter.delete("/", requireAdmin, async (c) => {
  const process_id = c.req.query("process_id");
  if (!process_id) return c.json({ error: "process_id query param required" }, 400);
  const deleted = await deleteCasesByProcess(process_id);
  return c.json({ ok: true, deleted, process_id });
});

// SSE stream: GET /cases/:id/stream — real-time case updates (closes #296)
casesRouter.get("/:id/stream", async (c) => {
  const id = c.req.param("id");

  const enc = new TextEncoder();
  const sse = (event: string, data: unknown) =>
    enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const stream = new ReadableStream({
    async start(ctrl) {
      // Send initial snapshot
      const initial = await getCase(id).catch(() => null);
      if (!initial) {
        ctrl.enqueue(sse("error", { message: "Case not found" }));
        ctrl.close();
        return;
      }
      ctrl.enqueue(sse("snapshot", initial));
      if (initial.status !== "running") {
        ctrl.enqueue(enc.encode(`event: done\ndata: {}\n\n`));
        ctrl.close();
        return;
      }

      // Poll for updates every 2s (Redis pub/sub alternative)
      let lastHistoryLen = initial.history?.length ?? 0;
      let lastPosition = initial.position ?? "";
      let lastStatus: CaseStatus = initial.status;
      let aborted = false;

      c.req.raw.signal?.addEventListener("abort", () => { aborted = true; });

      while (!aborted) {
        await new Promise(r => setTimeout(r, 2000));
        if (aborted) break;
        try {
          const updated = await getCase(id).catch(() => null);
          if (!updated) break;

          const newLen = updated.history?.length ?? 0;
          const newPos = updated.position ?? "";
          const newStatus = updated.status;

          if (newLen !== lastHistoryLen || newPos !== lastPosition || newStatus !== lastStatus) {
            ctrl.enqueue(sse("update", updated));
            lastHistoryLen = newLen;
            lastPosition = newPos;
            lastStatus = newStatus;
          }

          // Push a heartbeat every 10s to keep connection alive
          ctrl.enqueue(enc.encode(`: heartbeat\n\n`));

          if (newStatus !== "running") {
            ctrl.enqueue(enc.encode(`event: done\ndata: {}\n\n`));
            break;
          }
        } catch {
          break;
        }
      }
      ctrl.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
});

// Work Items router — mounted at /workitems
export const workitemsRouter = new Hono<HonoEnv>();
export const waitsRouter = new Hono<HonoEnv>();

workitemsRouter.post("/:id/complete", async (c) => {
  const id = c.req.param("id");
  const forbidden = await requireWorkItemOwnerOrAdmin(c, id);
  if (forbidden) return forbidden;
  const body = await c.req.json().catch(() => ({}));
  const output = body.output || {};
  const result = await executeActionDirect("workitem.complete", { id, output });
  return actionJson(c, result!);
});

workitemsRouter.get("/", async (c) => {
  const assigneeOrResponse = authorizedAssignee(c, c.req.query("assignee") || undefined);
  if (assigneeOrResponse instanceof Response) return assigneeOrResponse;
  const assignee = assigneeOrResponse;
  const status = (c.req.query("status") || undefined) as WorkItemStatus | undefined;
  const process_id = c.req.query("process_id") || undefined;
  const deadline_before = c.req.query("deadline_before") || undefined;
  const items = await listWorkItems({ assignee, status, process_id, deadline_before });
  return c.json(items);
});

workitemsRouter.post("/", requireAdmin, async (c) => {
  const body = await c.req.json();
  const { label, assignee, input = {}, deadline, process_id } = body;
  if (!label || !assignee) return c.json({ error: "label and assignee required" }, 400);
  const result = await executeActionDirect("workitem.create", { label, assignee, input, deadline, process_id });
  return actionJson(c, result!);
});

workitemsRouter.patch("/:id", requireAdmin, async (c) => {
  const id = c.req.param("id")!;
  const body = await c.req.json().catch(() => ({}));
  const { status, assignee, deadline, output, label } = body;
  const result = await executeActionDirect("workitem.update", { id, status, assignee, deadline, output, label });
  return actionJson(c, result!);
});

workitemsRouter.delete("/all", requireAdmin, async (c) => {
  const deleted = await purgeAllWorkItems();
  return c.json({ ok: true, deleted });
});

workitemsRouter.delete("/:id", requireAdmin, async (c) => {
  const id = c.req.param("id")!;
  const result = await executeActionDirect("workitem.cancel", { id });
  return actionJson(c, result!);
});

// POST /workitems/healthcheck — manual trigger for stuck work item recovery (#508)
workitemsRouter.post("/healthcheck", requireAdmin, async (c) => {
  const thresholdMs = parseInt(c.req.query("threshold_ms") || "60000");
  const result = await recoverStuckWorkItems(thresholdMs);
  return c.json(result);
});

waitsRouter.get("/", async (c) => {
  const assigneeOrResponse = authorizedAssignee(c, c.req.query("assignee") || undefined);
  if (assigneeOrResponse instanceof Response) return assigneeOrResponse;
  const assignee = assigneeOrResponse;
  const process_id = c.req.query("process_id") || undefined;
  const case_id = c.req.query("case_id") || undefined;
  const status = (c.req.query("status") || undefined) as EventWaitStatus | undefined;
  const waits = await listEventWaits({ assignee, process_id, case_id, status });

  return c.json({
    waits,
    summary: {
      total: waits.length,
      active: waits.filter((wait) => wait.status === "active").length,
      overdue: waits.filter((wait) => wait.status === "overdue").length,
      escalated: waits.filter((wait) => wait.status === "escalated").length,
      manual: waits.filter((wait) => wait.trigger_kind === "manual").length,
    },
  });
});

waitsRouter.post("/:id/confirm", async (c) => {
  const wait_id = c.req.param("id");
  const body: { comment?: string; confirmed_by?: string } =
    await c.req.json<{ comment?: string; confirmed_by?: string }>().catch(() => ({}));
  const wait = await loadEventWait(wait_id);
  if (!wait) return c.json({ error: "Wait not found" }, 404);
  const current = caller(c);
  if (!current.isAdmin && wait.assignee !== current.agentId) {
    return c.json({ error: "Forbidden: wait is assigned to another agent" }, 403);
  }
  if (!["active", "overdue", "escalated"].includes(wait.status)) {
    return c.json({ error: "Wait is not actionable", status: wait.status }, 409);
  }
  if (wait.trigger_kind !== "manual") {
    return c.json({ error: "Only manual waits can be confirmed", trigger_kind: wait.trigger_kind }, 400);
  }

  const kase = await getCase(wait.case_id);
  if (!kase) return c.json({ error: "Case not found" }, 404);
  if (kase.status !== "running") return c.json({ error: "Case is not running" }, 409);
  if (kase.position !== wait.element_id) {
    return c.json({ error: "Case is not waiting at this element", position: kase.position }, 409);
  }

  const def = await getWorkflow(kase.process_id);
  if (!def) return c.json({ error: "Workflow not found" }, 404);

  await emitEvent({
    type: "event.confirmed",
    case_id: wait.case_id,
    process_id: wait.process_id,
    element_id: wait.element_id,
    timestamp: new Date().toISOString(),
  });

  await resolveEventWaitForNode(wait.case_id, wait.element_id, {
    confirmed_by: body.confirmed_by,
    comment: body.comment,
  });

  const { advanceCase } = await import("../../../../src/runtime/cases/advancement");
  const updated = await advanceCase(kase, def);

  return c.json({
    ok: true,
    wait_id,
    case_id: wait.case_id,
    status: updated.status,
  });
});

// Reminders router — mounted at /reminders
export const remindersRouter = new Hono<HonoEnv>();

remindersRouter.get("/", async (c) => {
  const status = (c.req.query("status") || undefined) as ReminderStatus | undefined;
  const current = caller(c);
  const requestedRecipient = c.req.query("recipient") || undefined;
  if (!current.isAdmin && requestedRecipient && requestedRecipient !== current.agentId) {
    return c.json({ error: "Forbidden: can only list your own reminders" }, 403);
  }
  const recipient = current.isAdmin ? requestedRecipient : current.agentId ?? undefined;
  const result = await executeActionDirect("reminder.list", { status, recipient });
  return actionJson(c, result!);
});

remindersRouter.post("/", requireAdmin, async (c) => {
  const body = await c.req.json();
  const { type, recipient, message, scheduled_at, channel, case_id, process_id, element_id, work_item_id } = body;
  if (!recipient || !message || !scheduled_at) {
    return c.json({ error: "recipient, message and scheduled_at required" }, 400);
  }
  const result = await executeActionDirect("reminder.create", {
    type,
    recipient,
    message,
    scheduled_at,
    channel,
    case_id,
    process_id,
    element_id,
    work_item_id,
  });
  return actionJson(c, result!);
});

remindersRouter.patch("/:id/status", requireAdmin, async (c) => {
  const id = c.req.param("id")!;
  const body = await c.req.json().catch(() => ({}));
  const { status } = body;
  if (!status) return c.json({ error: "status required" }, 400);
  const result = await executeActionDirect("reminder.update_status", { id, status });
  return actionJson(c, result!);
});

remindersRouter.delete("/:id", requireAdmin, async (c) => {
  const id = c.req.param("id")!;
  const result = await executeActionDirect("reminder.delete", { id });
  return actionJson(c, result!);
});

export default casesRouter;
