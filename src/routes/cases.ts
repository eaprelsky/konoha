import { Hono } from "hono";
import { requireAuth } from "../middleware/auth";
import {
  createCase,
  getCase,
  forceCloseCase,
  completeWorkItem,
  listWorkItems,
  listCases,
  createStandaloneWorkItem,
  updateWorkItem,
  createReminder,
  listReminders,
  updateReminderStatus,
  deleteReminder,
  purgeAllWorkItems,
  type WorkItemStatus,
  type CaseStatus,
  type ReminderStatus,
  type ReminderChannel,
  type ReminderType,
} from "../runtime";

// Cases router — mounted at /cases
export const casesRouter = new Hono();

casesRouter.get("/", async (c) => {
  const status = (c.req.query("status") || undefined) as CaseStatus | undefined;
  const process_id = c.req.query("process_id") || undefined;
  const after = c.req.query("after") || undefined;
  const before = c.req.query("before") || undefined;
  const limit = Math.min(parseInt(c.req.query("limit") || "50"), 200);
  const offset = parseInt(c.req.query("offset") || "0");
  const result = await listCases({ status, process_id, after, before, limit, offset });
  return c.json(result);
});

casesRouter.post("/", async (c) => {
  const body = await c.req.json();
  const { process_id, subject, payload = {}, start_node } = body;
  if (!process_id || !subject) return c.json({ error: "process_id and subject required" }, 400);
  try {
    const kase = await createCase(process_id, subject, payload, start_node);
    return c.json(kase, 201);
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

casesRouter.get("/:id", async (c) => {
  const id = c.req.param("id");
  const kase = await getCase(id);
  if (!kase) return c.json({ error: "Case not found" }, 404);
  return c.json(kase);
});

casesRouter.post("/:id/close", requireAuth, async (c) => {
  const id = c.req.param("id");
  const kase = await forceCloseCase(id);
  if (!kase) return c.json({ error: "Case not found" }, 404);
  return c.json(kase);
});

// Work Items router — mounted at /workitems
export const workitemsRouter = new Hono();

workitemsRouter.post("/:id/complete", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const output = body.output || {};
  try {
    const result = await completeWorkItem(id, output);
    return c.json(result);
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

workitemsRouter.get("/", async (c) => {
  const assignee = c.req.query("assignee") || undefined;
  const status = (c.req.query("status") || undefined) as WorkItemStatus | undefined;
  const process_id = c.req.query("process_id") || undefined;
  const deadline_before = c.req.query("deadline_before") || undefined;
  const items = await listWorkItems({ assignee, status, process_id, deadline_before });
  return c.json(items);
});

workitemsRouter.post("/", async (c) => {
  const body = await c.req.json();
  const { label, assignee, input = {}, deadline } = body;
  if (!label || !assignee) return c.json({ error: "label and assignee required" }, 400);
  const wi = await createStandaloneWorkItem({ label, assignee, input, deadline });
  return c.json(wi, 201);
});

workitemsRouter.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const { status, assignee, deadline, output, label } = body;
  try {
    const wi = await updateWorkItem(id, { status, assignee, deadline, output, label });
    return c.json(wi);
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

workitemsRouter.delete("/all", requireAuth, async (c) => {
  const deleted = await purgeAllWorkItems();
  return c.json({ ok: true, deleted });
});

workitemsRouter.delete("/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const wi = await updateWorkItem(id, { status: "cancelled" });
    return c.json(wi);
  } catch (e: any) {
    return c.json({ error: e.message }, 404);
  }
});

// Reminders router — mounted at /reminders
export const remindersRouter = new Hono();

remindersRouter.get("/", async (c) => {
  const status = (c.req.query("status") || undefined) as ReminderStatus | undefined;
  const recipient = c.req.query("recipient") || undefined;
  const reminders = await listReminders({ status, recipient });
  return c.json(reminders);
});

remindersRouter.post("/", async (c) => {
  const body = await c.req.json();
  const { type, recipient, message, scheduled_at, channel, case_id, process_id, element_id } = body;
  if (!recipient || !message || !scheduled_at) {
    return c.json({ error: "recipient, message and scheduled_at required" }, 400);
  }
  const r = await createReminder({
    type: (type || "standalone") as ReminderType,
    recipient,
    message,
    scheduled_at,
    channel: (channel || "gui") as ReminderChannel,
    case_id,
    process_id,
    element_id,
  });
  return c.json(r, 201);
});

remindersRouter.patch("/:id/status", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const { status } = body;
  if (!status) return c.json({ error: "status required" }, 400);
  try {
    const r = await updateReminderStatus(id, status as ReminderStatus);
    return c.json(r);
  } catch (e: any) {
    return c.json({ error: e.message }, 404);
  }
});

remindersRouter.delete("/:id", async (c) => {
  const id = c.req.param("id");
  try {
    await deleteReminder(id);
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 404);
  }
});

export default casesRouter;
