/**
 * runtime/event-waits/persistence.ts — EventWait Redis + PG persistence.
 * Design: ADR-001 EventWait Runtime Entity (issue #491).
 */
import { randomUUID } from "crypto";
import { redis } from "../../redis";
import { createLogger } from "../../logger";
import type { EventWait, EventWaitStatus } from "./types";

export { type EventWait, type EventWaitStatus, type TriggerKind } from "./types";
export {
  type TimerWait,
  type TimerType,
  type EscalationPolicy,
  type EscalationStep,
  type TIMER_TRANSITIONS,
  canTransitionTimer,
  createTimerWait,
  loadTimerWait,
  loadDueTimerWaits,
  fireTimerWait,
  markTimerOverdue,
  escalateTimerWait,
  tickTimerWaits,
} from "./timer-wait";
export {
  type PingPolicy,
  type EscalationAction,
  scheduleWaitReminders,
  pingManualWait,
  sweepOverdueWaits,
  escalateWait,
  abortEscalatedWait,
} from "./wait-notifier";

const log = createLogger("runtime:event-waits");

const WAIT_KEY_PREFIX = "event-wait:";
const WAITS_IDX_CASE = "konoha:event-waits:case:";
const WAITS_IDX_STATUS = "konoha:event-waits:status:";
const WAITS_IDX_ACTIVE = "konoha:event-waits:active";
const ALL_WAIT_STATUSES: EventWaitStatus[] = ["active", "fired", "cancelled", "overdue", "escalated"];

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

export async function listEventWaits(filters: {
  case_id?: string;
  process_id?: string;
  assignee?: string;
  status?: EventWaitStatus;
} = {}): Promise<EventWait[]> {
  const statuses: EventWaitStatus[] = filters.status
    ? [filters.status]
    : ["active", "overdue", "escalated"];

  const statusIds = new Set<string>();
  for (const status of statuses) {
    const ids = await redis.smembers(WAITS_IDX_STATUS + status);
    for (const id of ids) statusIds.add(id);
  }

  let candidateIds = statusIds;
  if (filters.case_id) {
    const caseIds = new Set(await redis.smembers(WAITS_IDX_CASE + filters.case_id));
    candidateIds = new Set([...candidateIds].filter((id) => caseIds.has(id)));
  }

  const ids = [...candidateIds];
  if (ids.length === 0) return [];

  const waits = await Promise.all(ids.map(id => loadEventWait(id)));
  const filtered = waits.filter((wait): wait is EventWait => {
    if (!wait) return false;
    if (filters.status && wait.status !== filters.status) return false;
    if (!filters.status && !statuses.includes(wait.status)) return false;
    if (filters.case_id && wait.case_id !== filters.case_id) return false;
    if (filters.process_id && wait.process_id !== filters.process_id) return false;
    if (filters.assignee && wait.assignee !== filters.assignee) return false;
    return true;
  });

  return filtered.sort((a, b) => {
    const aDeadline = a.deadline ? new Date(a.deadline).getTime() : Number.MAX_SAFE_INTEGER;
    const bDeadline = b.deadline ? new Date(b.deadline).getTime() : Number.MAX_SAFE_INTEGER;
    if (aDeadline !== bDeadline) return aDeadline - bDeadline;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
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

// ── Bulk operations ────────────────────────────────────────────────────────

/** Cancel all active waits for a case (on case complete/error). */
export async function cancelEventWaitsForCase(case_id: string): Promise<void> {
  const waits = await loadActiveWaitsForCase(case_id);
  for (const w of waits) {
    await updateEventWaitStatus(w.wait_id, "cancelled");
  }
  if (waits.length > 0) {
    log.info("cancelled event waits for case", { case_id, count: waits.length });
  }
}

/** Resolve the EventWait matching a case+node when an event fires. */
export async function resolveEventWaitForNode(
  case_id: string,
  element_id: string,
  event_data?: Record<string, unknown>,
): Promise<void> {
  const waits = await loadActiveWaitsForCase(case_id);
  const match = waits.find(w => w.element_id === element_id);
  if (match) {
    await updateEventWaitStatus(match.wait_id, "fired", { event_data });
    log.info("resolved event wait on fire", { wait_id: match.wait_id, case_id, element_id });
  }
}

// ── Persistence ─────────────────────────────────────────────────────────────

async function saveEventWait(wait: EventWait): Promise<void> {
  const key = WAIT_KEY_PREFIX + wait.wait_id;

  await redis.set(key, JSON.stringify(wait));

  // Index by case
  await redis.sadd(WAITS_IDX_CASE + wait.case_id, wait.wait_id);

  // Index by status
  for (const status of ALL_WAIT_STATUSES) {
    if (status !== wait.status) {
      await redis.srem(WAITS_IDX_STATUS + status, wait.wait_id);
    }
  }
  await redis.sadd(WAITS_IDX_STATUS + wait.status, wait.wait_id);

  // Active index (for restart recovery)
  if (wait.status === "active") {
    await redis.sadd(WAITS_IDX_ACTIVE, wait.wait_id);
  } else {
    await redis.srem(WAITS_IDX_ACTIVE, wait.wait_id);
  }
}
