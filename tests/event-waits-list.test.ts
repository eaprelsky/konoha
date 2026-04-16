import { afterAll, afterEach, describe, expect, test } from "bun:test";
import Redis from "ioredis";
import {
  createEventWait,
  listEventWaits,
  updateEventWaitStatus,
  type EventWait,
} from "../src/runtime/event-waits";

const redis = new Redis({ host: "127.0.0.1", port: 6379, db: parseInt(process.env.REDIS_DB ?? "0") });
const RUN = `ew${Date.now()}`;
const ALL_STATUSES = ["active", "fired", "cancelled", "overdue", "escalated"] as const;
const createdWaits: EventWait[] = [];

async function trackWait(params: Parameters<typeof createEventWait>[0]): Promise<EventWait> {
  const wait = await createEventWait(params);
  createdWaits.push(wait);
  return wait;
}

afterEach(async () => {
  while (createdWaits.length > 0) {
    const wait = createdWaits.pop()!;
    await redis.del(`event-wait:${wait.wait_id}`);
    await redis.srem(`konoha:event-waits:case:${wait.case_id}`, wait.wait_id);
    await redis.srem("konoha:event-waits:active", wait.wait_id);
    for (const status of ALL_STATUSES) {
      await redis.srem(`konoha:event-waits:status:${status}`, wait.wait_id);
    }
  }
});

afterAll(() => {
  redis.disconnect();
});

describe("listEventWaits", () => {
  test("returns active, overdue, and escalated waits as a union sorted by deadline", async () => {
    const active = await trackWait({
      case_id: `case-active-${RUN}`,
      process_id: `proc-a-${RUN}`,
      element_id: "approve",
      element_label: "Approve Request",
      trigger_kind: "manual",
      assignee: "kakashi",
      deadline: "2026-04-16T10:00:00.000Z",
    });
    const overdue = await trackWait({
      case_id: `case-overdue-${RUN}`,
      process_id: `proc-a-${RUN}`,
      element_id: "await-payment",
      element_label: "Await Payment",
      trigger_kind: "manual",
      assignee: "kakashi",
      deadline: "2026-04-16T09:00:00.000Z",
    });
    const escalated = await trackWait({
      case_id: `case-escalated-${RUN}`,
      process_id: `proc-b-${RUN}`,
      element_id: "manager-review",
      element_label: "Manager Review",
      trigger_kind: "manual",
      assignee: "naruto",
      deadline: "2026-04-16T11:00:00.000Z",
    });
    const fired = await trackWait({
      case_id: `case-fired-${RUN}`,
      process_id: `proc-b-${RUN}`,
      element_id: "webhook",
      element_label: "Webhook",
      trigger_kind: "message",
      assignee: "naruto",
      deadline: "2026-04-16T08:00:00.000Z",
    });

    await updateEventWaitStatus(overdue.wait_id, "overdue");
    await updateEventWaitStatus(escalated.wait_id, "escalated");
    await updateEventWaitStatus(fired.wait_id, "fired");

    const visible = await listEventWaits();
    expect(visible.map((wait) => wait.wait_id)).toEqual([
      overdue.wait_id,
      active.wait_id,
      escalated.wait_id,
    ]);

    const firedOnly = await listEventWaits({ status: "fired" });
    expect(firedOnly.map((wait) => wait.wait_id)).toEqual([fired.wait_id]);
  });

  test("applies assignee, process_id, and case_id filters on canonical waits", async () => {
    const kakashiWait = await trackWait({
      case_id: `case-filter-a-${RUN}`,
      process_id: `proc-filter-${RUN}`,
      element_id: "collect-data",
      trigger_kind: "manual",
      assignee: "kakashi",
      deadline: "2026-04-17T09:00:00.000Z",
    });
    const sameProcessOtherAssignee = await trackWait({
      case_id: `case-filter-b-${RUN}`,
      process_id: `proc-filter-${RUN}`,
      element_id: "collect-approval",
      trigger_kind: "manual",
      assignee: "sakura",
      deadline: "2026-04-17T10:00:00.000Z",
    });
    const otherProcess = await trackWait({
      case_id: `case-filter-c-${RUN}`,
      process_id: `proc-other-${RUN}`,
      element_id: "notify",
      trigger_kind: "manual",
      assignee: "kakashi",
      deadline: "2026-04-17T11:00:00.000Z",
    });

    await updateEventWaitStatus(sameProcessOtherAssignee.wait_id, "overdue");

    const byAssignee = await listEventWaits({ assignee: "kakashi" });
    expect(byAssignee.map((wait) => wait.wait_id)).toEqual([
      kakashiWait.wait_id,
      otherProcess.wait_id,
    ]);

    const byProcess = await listEventWaits({ process_id: `proc-filter-${RUN}` });
    expect(byProcess.map((wait) => wait.wait_id)).toEqual([
      kakashiWait.wait_id,
      sameProcessOtherAssignee.wait_id,
    ]);

    const byCase = await listEventWaits({ case_id: otherProcess.case_id });
    expect(byCase.map((wait) => wait.wait_id)).toEqual([otherProcess.wait_id]);
  });
});
