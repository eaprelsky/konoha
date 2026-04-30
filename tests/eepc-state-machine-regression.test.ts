import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import Redis from "ioredis";
import { createCase, deleteCasesByProcess, handleEventFired, processEvent } from "../src/runtime";
import { completeWorkItem } from "../src/runtime/work-items";
import { loadActiveWaitsForCase } from "../src/runtime/event-waits";
import { deleteReminder, listReminders } from "../src/runtime/reminders";
import { loadInstructionText } from "../src/document-instructions";
import { createWorkflow } from "../src/workflow-loader";
import { pgDeleteWorkflow } from "../src/storage/pg";
import { cancelSubscriptionsByInstance } from "../src/event-manager";
import { normalizeTelegramStreamEvent, routeMessengerEventToWorkflows } from "../src/messenger-event-router";
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
    await cancelSubscriptionsByInstance(caseId).catch(() => 0);
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

async function pendingWorkItemForCase(caseId: string, elementId: string): Promise<Record<string, any>> {
  const items = await workItemsForCase(caseId);
  const item = items.find(wi => wi.element_id === elementId && wi.status === "pending");
  if (!item) throw new Error(`Pending work item not found for ${elementId}`);
  return item;
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
    expect(await loadActiveWaitsForCase(kase.case_id)).toEqual([]);
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
    expect(await loadActiveWaitsForCase(kase.case_id)).toEqual([]);
  });

  test("sales workflow turns Telegram lead into lead triage and sales owner work items", async () => {
    const id = wfId("sales-lead-intake");
    const raw = readFileSync(join(import.meta.dir, "..", "workflows", "sales", "lead-qualification.json"), "utf-8");
    const def: WorkflowDefinition = { ...JSON.parse(raw), id };
    await registerWorkflow(def);

    const kase = await createCase(id, "coMind Лиды: AI assistant request", {
      source_chat: "coMind Лиды",
      source_agent: "sasuke",
      raw_message: "Нужен AI ассистент для обработки заявок и подготовки КП",
    });

    expect(kase.status).toBe("running");
    expect(kase.position).toBe("f1");

    const triage = await pendingWorkItemForCase(kase.case_id, "f1");
    expect(triage.assignee).toBe("lead_triage_specialist");
    expect(triage.input.source_chat).toBe("coMind Лиды");
    expect(triage.input._intent).toBeUndefined();
    const triageInstruction = await loadInstructionText(["sales.lead.triage"]);
    expect(triageInstruction).toContain("Classify the Telegram signal");

    const afterTriage = await completeWorkItem(triage.work_item_id, {
      classification: "sales_lead",
      summary: "Client asks for an AI assistant for lead handling and proposal preparation.",
    });
    expect(afterTriage.case?.position).toBe("f_notify_owner");

    const ownerNotification = await pendingWorkItemForCase(kase.case_id, "f_notify_owner");
    expect(ownerNotification.assignee).toBe("sales_owner");
    const notificationInstruction = await loadInstructionText(["sales.lead.owner-notification"]);
    expect(notificationInstruction).toContain("Notify the sales owner");

    const afterNotification = await completeWorkItem(ownerNotification.work_item_id, {
      owner_summary: "New lead needs sales owner review.",
      next_review_action: "decide_continue",
    });
    expect(afterNotification.case?.position).toBe("f2");

    const review = await pendingWorkItemForCase(kase.case_id, "f2");
    expect(review.assignee).toBe("sales_owner");
    expect(review.input.raw_message).toContain("AI ассистент");

    const afterReview = await completeWorkItem(review.work_item_id, {
      decision: "continue",
      next_step: "prepare_content_proposal",
    });
    expect(afterReview.case?.position).toBe("f3");

    const contentProposal = await pendingWorkItemForCase(kase.case_id, "f3");
    expect(contentProposal.assignee).toBe("sales_owner");
    await completeWorkItem(contentProposal.work_item_id, {
      proposal_outline: "Discovery, lead intake automation, proposal drafting workflow.",
    });

    const estimateRequest = await pendingWorkItemForCase(kase.case_id, "f4");
    expect(estimateRequest.assignee).toBe("sales_owner");
    await completeWorkItem(estimateRequest.work_item_id, {
      estimate_scope: "MVP workflow plus Telegram intake integration.",
    });

    const commercialProposal = await pendingWorkItemForCase(kase.case_id, "f5");
    expect(commercialProposal.assignee).toBe("sales_owner");
    const waitingForFollowUp = await completeWorkItem(commercialProposal.work_item_id, {
      follow_up: "Send commercial proposal and schedule discovery.",
    });

    expect(waitingForFollowUp.case?.status).toBe("running");
    expect(waitingForFollowUp.case?.position).toBe("e6");
    expect(waitingForFollowUp.case?.history.map(h => h.element_id)).toContain("f5");
    const waits = await loadActiveWaitsForCase(kase.case_id);
    expect(waits).toHaveLength(1);
    expect(waits[0].element_id).toBe("e6");
    expect(waits[0].trigger_kind).toBe("delay_after");
  });

  test("Telegram message event starts sales workflow only when eEPC trigger filter matches", async () => {
    const id = wfId("sales-telegram-event");
    const raw = readFileSync(join(import.meta.dir, "..", "workflows", "sales", "lead-qualification.json"), "utf-8");
    const def: WorkflowDefinition = { ...JSON.parse(raw), id };
    const chatTitle = `${RUN} Лиды`;
    const start = def.elements.find(el => el.id === "e1");
    if (start?.trigger?.filter) start.trigger.filter = { chat_title: chatTitle };
    await registerWorkflow(def);

    const cases = await processEvent("telegram.message.received", "telegram", {
      chat_title: chatTitle,
      chat_id: "-1001",
      sender_name: "Client",
      text: "Нужен AI ассистент для обработки заявок",
      msg_id: "42",
    });

    expect(cases).toHaveLength(1);
    expect(cases[0].process_id).toBe(id);
    expect(cases[0].subject).toBe("Нужен AI ассистент для обработки заявок");
    expect(cases[0].position).toBe("f1");
    expect(cases[0].payload.chat_title).toBe(chatTitle);

    const ignored = await processEvent("telegram.message.received", "telegram", {
      chat_title: "Random Chat",
      text: "Постороннее сообщение",
    });
    expect(ignored).toEqual([]);
  });

  test("connector-normalized Telegram event starts sales workflow without sales-specific router", async () => {
    const id = wfId("sales-connector-event");
    const raw = readFileSync(join(import.meta.dir, "..", "workflows", "sales", "lead-qualification.json"), "utf-8");
    const def: WorkflowDefinition = { ...JSON.parse(raw), id };
    const chatTitle = `${RUN} Connector Leads`;
    const start = def.elements.find(el => el.id === "e1");
    if (start?.trigger?.filter) start.trigger.filter = { chat_title: chatTitle };
    await registerWorkflow(def);

    const event = normalizeTelegramStreamEvent({
      endpoint_id: "telegram-user-sasuke",
      stream: "telegram:incoming",
      stream_id: `${Date.now()}-0`,
      fields: {
        chat_title: chatTitle,
        chat_id: "-1002",
        chat_type: "group",
        sender_name: "Client",
        text: "Хотим внедрить workflow для продаж",
        msg_id: "77",
      },
    });

    const cases = await routeMessengerEventToWorkflows(event);

    expect(cases).toHaveLength(1);
    expect(cases[0].process_id).toBe(id);
    expect(cases[0].position).toBe("f1");
    expect(cases[0].payload).toMatchObject({
      connector_id: "telegram-main",
      endpoint_id: "telegram-user-sasuke",
      provider: "telegram",
      event_kind: "message",
      chat_type: "group",
      chat_title: chatTitle,
      text: "Хотим внедрить workflow для продаж",
    });
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

  test("function output updates case payload before gateway evaluation", async () => {
    const id = wfId("function-output-gateway");
    await registerWorkflow({
      id,
      version: "1.0.0",
      name: "Function output gateway regression",
      elements: [
        { id: "start", type: "event", label: "Started" },
        { id: "triage", type: "function", label: "Triage", role: "lead_triage_specialist" },
        { id: "route", type: "gateway", label: "Route", operator: "XOR" },
        { id: "accept", type: "function", label: "Accept lead", role: "sales_owner" },
        { id: "reject", type: "function", label: "Reject lead", role: "sales_owner" },
        { id: "end", type: "event", label: "Finished" },
      ],
      flow: [
        ["start", "triage"],
        ["triage", "route"],
        ["route", "accept", "payload.lead_relevant === true"],
        ["route", "reject", "payload.lead_relevant === false"],
        ["accept", "end"],
        ["reject", "end"],
      ],
    });

    const kase = await createCase(id, "function-output-gateway", { source_chat: "coMind Лиды" });
    const triage = await pendingWorkItemForCase(kase.case_id, "triage");

    const afterTriage = await completeWorkItem(triage.work_item_id, {
      lead_relevant: true,
      lead_type: "sales_lead",
    });

    expect(afterTriage.case?.payload.lead_relevant).toBe(true);
    expect(afterTriage.case?.payload.lead_type).toBe("sales_lead");
    expect(afterTriage.case?.position).toBe("accept");

    const accept = await pendingWorkItemForCase(kase.case_id, "accept");
    expect(accept.assignee).toBe("sales_owner");
    expect(accept.input.lead_type).toBe("sales_lead");
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

    const duplicateAdvance = await completeWorkItem(item.work_item_id, { reviewed: true }).catch((error: Error) => error);
    expect(duplicateAdvance).toBeInstanceOf(Error);
    expect(await loadActiveWaitsForCase(kase.case_id)).toHaveLength(1);
  });

  test("delay_after event wait is visible and advances when fired", async () => {
    const id = wfId("delay-after-wait");
    await registerWorkflow({
      id,
      version: "1.0.0",
      name: "Delay-after wait regression",
      elements: [
        { id: "start", type: "event", label: "Started" },
        { id: "prepare", type: "function", label: "Prepare", role: "qa" },
        { id: "due", type: "event", label: "Reminder due", trigger: { kind: "delay_after", duration: "PT1S" } },
        { id: "followup", type: "function", label: "Follow up", role: "qa" },
        { id: "end", type: "event", label: "Finished" },
      ],
      flow: [["start", "prepare"], ["prepare", "due"], ["due", "followup"], ["followup", "end"]],
    });

    const kase = await createCase(id, "delay-after-wait", {});
    const prepare = await pendingWorkItemForCase(kase.case_id, "prepare");
    const paused = await completeWorkItem(prepare.work_item_id, { prepared: true });

    expect(paused.case?.status).toBe("running");
    expect(paused.case?.position).toBe("due");
    const waits = await loadActiveWaitsForCase(kase.case_id);
    expect(waits).toHaveLength(1);
    expect(waits[0].element_id).toBe("due");
    expect(waits[0].trigger_kind).toBe("delay_after");

    const advanced = await handleEventFired({
      event_id: "due",
      process_id: id,
      instance_id: kase.case_id,
      source_data: { timer_fired: true },
      idempotency_key: `${RUN}-delay-after`,
    });

    expect(advanced?.position).toBe("followup");
    expect(advanced?.payload.timer_fired).toBe(true);
    const followup = await pendingWorkItemForCase(kase.case_id, "followup");
    expect(followup.assignee).toBe("qa");
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
    expect(first ? await loadActiveWaitsForCase(first.case_id) : []).toEqual([]);
  });

  test("OR gateway activates all branches with true conditions", async () => {
    const id = wfId("or");
    await registerWorkflow({
      id,
      version: "1.0.0",
      name: "OR regression",
      elements: [
        { id: "start", type: "event", label: "Started" },
        { id: "split", type: "gateway", label: "Split", operator: "OR" },
        { id: "taskA", type: "function", label: "Task A", role: "qa" },
        { id: "taskB", type: "function", label: "Task B", role: "qa" },
        { id: "join", type: "gateway", label: "Join", operator: "XOR" },
        { id: "end", type: "event", label: "Finished" },
      ],
      flow: [
        ["start", "split"],
        ["split", "taskA", "payload.doA === true"],
        ["split", "taskB", "payload.doB === true"],
        ["taskA", "join"],
        ["taskB", "join"],
        ["join", "end"],
      ],
    });

    const kase = await createCase(id, "or-both", { doA: true, doB: true });
    expect(kase.status).toBe("running");
    expect(kase.position).toBe("split");
    expect(kase.active_branches?.map(b => b.element_id).sort()).toEqual(["taskA", "taskB"]);

    const items = (await workItemsForCase(kase.case_id)).sort((a, b) => String(a.element_id).localeCompare(String(b.element_id)));
    expect(items).toHaveLength(2);

    const first = await completeWorkItem(items[0].work_item_id, {});
    expect(first.case?.status).toBe("running");
    expect(first.case?.active_branches?.filter(b => b.done)).toHaveLength(1);

    const second = await completeWorkItem(items[1].work_item_id, {});
    expect(second.case?.status).toBe("done");
    expect(second.case?.position).toBe("end");
    expect(second.case?.active_branches).toBeUndefined();
  });

  test("OR gateway with one true condition activates only that branch", async () => {
    const id = wfId("or-single");
    await registerWorkflow({
      id,
      version: "1.0.0",
      name: "OR single branch regression",
      elements: [
        { id: "start", type: "event", label: "Started" },
        { id: "split", type: "gateway", label: "Split", operator: "OR" },
        { id: "taskA", type: "function", label: "Task A", role: "qa" },
        { id: "taskB", type: "function", label: "Task B", role: "qa" },
        { id: "end", type: "event", label: "Finished" },
      ],
      flow: [
        ["start", "split"],
        ["split", "taskA", "payload.doA === true"],
        ["split", "taskB", "payload.doB === true"],
        ["taskA", "end"],
        ["taskB", "end"],
      ],
    });

    const kase = await createCase(id, "or-single", { doA: true, doB: false });
    expect(kase.status).toBe("running");
    expect(kase.position).toBe("split");
    expect(kase.active_branches?.map(b => b.element_id)).toEqual(["taskA"]);

    const items = await workItemsForCase(kase.case_id);
    expect(items).toHaveLength(1);
    expect(items[0].element_id).toBe("taskA");
  });

  test("XOR gateway with no matching condition puts case in error", async () => {
    const id = wfId("xor-no-match");
    await registerWorkflow({
      id,
      version: "1.0.0",
      name: "XOR no-match error regression",
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

    const kase = await createCase(id, "xor-no-match", { path: "wrong" });
    expect(kase.status).toBe("error");
    expect(kase.position).toBe("route");
    expect(kase.history.map(h => h.element_id)).toContain("route");
    expect(await workItemsForCase(kase.case_id)).toEqual([]);
  });

  test("subprocess function creates child case and pauses parent", async () => {
    const childId = wfId("subprocess-child");
    await registerWorkflow({
      id: childId,
      version: "1.0.0",
      name: "Child process",
      elements: [
        { id: "c_start", type: "event", label: "Child Started" },
        { id: "c_task", type: "function", label: "Child Task", role: "qa" },
        { id: "c_end", type: "event", label: "Child Finished" },
      ],
      flow: [["c_start", "c_task"], ["c_task", "c_end"]],
    });

    const parentId = wfId("subprocess-parent");
    await registerWorkflow({
      id: parentId,
      version: "1.0.0",
      name: "Parent process",
      elements: [
        { id: "start", type: "event", label: "Started" },
        { id: "delegate", type: "function", label: "Delegate", role: "qa", sub_process_id: childId },
        { id: "end", type: "event", label: "Finished" },
      ],
      flow: [["start", "delegate"], ["delegate", "end"]],
    });

    const kase = await createCase(parentId, "subprocess-parent", {});
    expect(kase.status).toBe("running");
    expect(kase.position).toBe("delegate");

    const items = await workItemsForCase(kase.case_id);
    expect(items).toHaveLength(1);
    // Subprocess function creates a child case
    const wi = items[0];
    expect(wi.child_case_id).toBeDefined();
    if (wi.child_case_id) {
      const { getCase } = await import("../src/runtime/cases/crud");
      const childCase = await getCase(wi.child_case_id);
      expect(childCase).toBeDefined();
      expect(childCase?.parent_case_id).toBe(kase.case_id);
    }
  });

  test("force-closed case with active branches cleans up branches and subscriptions", async () => {
    const id = wfId("force-close-branches");
    await registerWorkflow({
      id,
      version: "1.0.0",
      name: "Force close with branches regression",
      elements: [
        { id: "start", type: "event", label: "Started" },
        { id: "split", type: "gateway", label: "Split", operator: "AND" },
        { id: "taskA", type: "function", label: "Task A", role: "qa" },
        { id: "taskB", type: "function", label: "Task B", role: "qa" },
        { id: "join", type: "gateway", label: "Join", operator: "AND" },
        { id: "end", type: "event", label: "Finished" },
      ],
      flow: [
        ["start", "split"],
        ["split", "taskA"], ["split", "taskB"],
        ["taskA", "join"], ["taskB", "join"],
        ["join", "end"],
      ],
    });

    const kase = await createCase(id, "force-close-branches", {});
    expect(kase.active_branches).toBeDefined();
    expect(kase.active_branches!.length).toBe(2);

    const { forceCloseCase } = await import("../src/runtime");
    const closed = await forceCloseCase(kase.case_id);
    expect(closed?.status).toBe("done");
    expect(closed?.active_branches).toBeUndefined();
    expect(await loadActiveWaitsForCase(kase.case_id)).toEqual([]);
  });
});
