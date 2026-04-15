/**
 * runtime/event-waits/persistence.ts — EventWait Redis + PG persistence.
 * Design: ADR-001 EventWait Runtime Entity (issue #491).
 */
import { randomUUID } from "crypto";
import { redis } from "../../redis";
import { createLogger } from "../../logger";
import type { EventWait, EventWaitStatus } from "./types";

export { type EventWait, type EventWaitStatus, type TriggerKind } from "./types";

const log = createLogger("runtime:event-waits");

const WAIT_KEY_PREFIX = "event-wait:";
const WAITS_IDX_CASE = "konoha:event-waits:case:";
const WAITS_IDX_STATUS = "konoha:event-waits:status:";
const WAITS_IDX_ACTIVE = "konoha:event-waits:active";

// ── Create ──────────────────────────────────────────────────────────────────

export async function createEventWait(params: {
  case_id: string;
  process_id: string;
  element_id: string;
  element_label?: string;
  trigger_kind: EventWait["trigger_kind"];
  deadline?: string;
  assignee?: string;
  subscription_id?: string;
  escalation_target?: string;
}): Promise<EventWait> {
  const wait: EventWait = {
    wait_id: randomUUID(),
    case_id: params.case_id,
    process_id: params.process_id,
    element_id: params.element_id,
    element_label: params.element_label,
    trigger_kind: params.trigger_kind,
    status: "active",
    created_at: new Date().toISOString(),
    deadline: params.deadline,
    assignee: params.assignee,
    subscription_id: params.subscription_id,
    reminder_count: 0,
    escalation_target: params.escalation_target,
  };

  await saveEventWait(wait);
  log.info("event wait created", { wait_id: wait.wait_id, case_id: wait.case_id, element_id: wait.element_id, trigger_kind: wait.trigger_kind });
  return wait;
}

// ── Read ────────────────────────────────────────────────────────────────────

export async function loadEventWait(wait_id: string): Promise<EventWait | null> {
  const raw = await redis.get(WAIT_KEY_PREFIX + wait_id);
  return raw ? JSON.parse(raw) : null;
}

export async function loadActiveWaitsForCase(case_id: string): Promise<EventWait[]> {
  const ids = await redis.smembers(WAITS_IDX_CASE + case_id);
  const waits = await Promise.all(ids.map(id => loadEventWait(id)));
  return waits.filter((w): w is EventWait => w !== null && w.status === "active");
}

export async function loadActiveWaits(): Promise<EventWait[]> {
  const ids = await redis.smembers(WAITS_IDX_ACTIVE);
  const waits = await Promise.all(ids.map(id => loadEventWait(id)));
  return waits.filter((w): w is EventWait => w !== null && w.status === "active");
}

// ── Update ──────────────────────────────────────────────────────────────────

export async function updateEventWaitStatus(
  wait_id: string,
  status: EventWaitStatus,
  extra?: { event_data?: Record<string, unknown> },
): Promise<EventWait | null> {
  const wait = await loadEventWait(wait_id);
  if (!wait) return null;

  const prevStatus = wait.status;
  wait.status = status;
  if (status === "fired" || status === "cancelled") {
    wait.resolved_at = new Date().toISOString();
  }
  if (extra?.event_data) {
    wait.event_data = extra.event_data;
  }

  await saveEventWait(wait);
  log.info("event wait status changed", { wait_id, from: prevStatus, to: status });
  return wait;
}

export async function incrementReminderCount(wait_id: string): Promise<void> {
  const wait = await loadEventWait(wait_id);
  if (!wait) return;
  wait.reminder_count = (wait.reminder_count ?? 0) + 1;
  wait.last_reminder_at = new Date().toISOString();
  await saveEventWait(wait);
}

// ── Persistence ─────────────────────────────────────────────────────────────

async function saveEventWait(wait: EventWait): Promise<void> {
  const key = WAIT_KEY_PREFIX + wait.wait_id;

  await redis.set(key, JSON.stringify(wait));

  // Index by case
  await redis.sadd(WAITS_IDX_CASE + wait.case_id, wait.wait_id);

  // Index by status
  await redis.sadd(WAITS_IDX_STATUS + wait.status, wait.wait_id);

  // Active index (for restart recovery)
  if (wait.status === "active") {
    await redis.sadd(WAITS_IDX_ACTIVE, wait.wait_id);
  } else {
    await redis.srem(WAITS_IDX_ACTIVE, wait.wait_id);
  }
}
