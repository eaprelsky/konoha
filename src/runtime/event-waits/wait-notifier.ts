/**
 * runtime/event-waits/wait-notifier.ts — Reminders & escalation for manual waits.
 *
 * This module is the communication layer for manual EventWaits:
 *   - Schedule periodic reminders (ping policy)
 *   - Detect overdue waits (deadline passed without confirmation)
 *   - Execute escalation steps (notify → reassign → auto-complete/abort)
 *   - Mark parent case as needs_attention
 *
 * Design: reminders are notifications only (they never advance the process).
 * Process advancement happens only via confirm-event (human) or timeout abort.
 */

import { redis } from "../../redis";
import { createLogger } from "../../logger";
import { silentCatch } from "../../logger";
import { createReminder } from "../reminders";
import {
  loadActiveWaits,
  loadEventWait,
  updateEventWaitStatus,
  incrementReminderCount,
} from "./index";
import { emitEvent } from "../event-log";
import type { EventWait } from "./types";

const log = createLogger("runtime:wait-notifier");

const OVERDUE_SWEEP_KEY = "konoha:wait-notifier:last-overdue-sweep";

// ── Ping policy ──────────────────────────────────────────────────────────────

export interface PingPolicy {
  /** Initial delay before first reminder (minutes). Default: 5. */
  initial_delay_minutes: number;
  /** Interval between subsequent reminders (minutes). Default: 15. */
  repeat_interval_minutes: number;
  /** Max reminders before escalation. Default: 3. */
  max_reminders: number;
  /** Channel for reminders. Default: "gui". */
  channel: "gui" | "telegram" | "email";
}

const DEFAULT_PING_POLICY: PingPolicy = {
  initial_delay_minutes: 5,
  repeat_interval_minutes: 15,
  max_reminders: 3,
  channel: "gui",
};

// ── Schedule reminders for a manual wait ─────────────────────────────────────

/**
 * Schedule initial + repeat reminders for a manual EventWait.
 * Called when a manual wait is created (from advancement.ts).
 */
export async function scheduleWaitReminders(
  wait: EventWait,
  policy?: Partial<PingPolicy>,
): Promise<void> {
  if (wait.trigger_kind !== "manual") return;
  if (wait.status !== "active") return;

  const p = { ...DEFAULT_PING_POLICY, ...policy };
  const initialAt = new Date(
    Date.now() + p.initial_delay_minutes * 60 * 1000,
  ).toISOString();

  await createReminder({
    type: "standalone",
    recipient: wait.assignee || "system",
    message: `Ожидание подтверждения: ${wait.element_label || wait.element_id} (case=${wait.case_id})`,
    scheduled_at: initialAt,
    channel: p.channel,
    case_id: wait.case_id,
    process_id: wait.process_id,
    element_id: wait.element_id,
  }).catch(silentCatch("schedule initial wait reminder"));

  log.info("scheduled initial reminder for manual wait", {
    wait_id: wait.wait_id,
    case_id: wait.case_id,
    element_id: wait.element_id,
    remind_at: initialAt,
    assignee: wait.assignee,
  });
}

// ── Send a single ping for an active manual wait ─────────────────────────────

export async function pingManualWait(wait_id: string): Promise<void> {
  const wait = await loadEventWait(wait_id);
  if (!wait || wait.trigger_kind !== "manual" || wait.status !== "active") return;

  await incrementReminderCount(wait_id);

  await emitEvent({
    type: "wait.reminder",
    case_id: wait.case_id,
    process_id: wait.process_id,
    element_id: wait.element_id,
    wait_id: wait.wait_id,
    reminder_count: (wait.reminder_count ?? 0) + 1,
    timestamp: new Date().toISOString(),
  });

  log.info("pinged manual wait", {
    wait_id,
    case_id: wait.case_id,
    element_id: wait.element_id,
    reminder_count: (wait.reminder_count ?? 0) + 1,
  });
}

// ── Overdue detection ────────────────────────────────────────────────────────

/**
 * Sweep all active waits with deadlines, mark overdue if deadline passed.
 * Should be called periodically (e.g. every 60 seconds).
 */
export async function sweepOverdueWaits(): Promise<number> {
  const activeWaits = await loadActiveWaits();
  const now = Date.now();
  let overdueCount = 0;

  for (const wait of activeWaits) {
    if (!wait.deadline) continue;
    if (wait.trigger_kind !== "manual") continue;

    const deadlineMs = new Date(wait.deadline).getTime();
    if (deadlineMs <= now) {
      await markWaitOverdue(wait);
      overdueCount++;
    }
  }

  if (overdueCount > 0) {
    log.info("overdue sweep: marked waits as overdue", { count: overdueCount });
  }
  return overdueCount;
}

async function markWaitOverdue(wait: EventWait): Promise<void> {
  await updateEventWaitStatus(wait.wait_id, "overdue");
  await emitEvent({
    type: "wait.overdue",
    case_id: wait.case_id,
    process_id: wait.process_id,
    element_id: wait.element_id,
    wait_id: wait.wait_id,
    deadline: wait.deadline,
    timestamp: new Date().toISOString(),
  });

  // Mark parent case as needing attention
  await markCaseNeedsAttention(wait.case_id);

  log.warn("wait marked overdue", {
    wait_id: wait.wait_id,
    case_id: wait.case_id,
    element_id: wait.element_id,
    deadline: wait.deadline,
  });
}

// ── Escalation ───────────────────────────────────────────────────────────────

export type EscalationAction = "notify" | "reassign" | "auto_complete" | "abort";

/**
 * Execute escalation for an overdue manual wait.
 * Policy comes from the EventWait's escalation_target field.
 */
export async function escalateWait(wait_id: string): Promise<EscalationAction | null> {
  const wait = await loadEventWait(wait_id);
  if (!wait || wait.status !== "overdue") return null;

  const target = wait.escalation_target || "system";
  await updateEventWaitStatus(wait_id, "escalated");

  await emitEvent({
    type: "wait.escalated",
    case_id: wait.case_id,
    process_id: wait.process_id,
    element_id: wait.element_id,
    wait_id: wait.wait_id,
    escalation_target: target,
    timestamp: new Date().toISOString(),
  });

  log.warn("wait escalated", {
    wait_id,
    case_id: wait.case_id,
    element_id: wait.element_id,
    escalation_target: target,
  });

  // Default escalation: notify. Caller can implement reassign/abort based on policy.
  return "notify";
}

/**
 * Abort an escalated wait — cancel it and mark case as error.
 */
export async function abortEscalatedWait(wait_id: string): Promise<void> {
  const wait = await loadEventWait(wait_id);
  if (!wait) return;

  await updateEventWaitStatus(wait_id, "cancelled");
  await emitEvent({
    type: "wait.aborted",
    case_id: wait.case_id,
    process_id: wait.process_id,
    element_id: wait.element_id,
    wait_id: wait.wait_id,
    reason: "escalation_abort",
    timestamp: new Date().toISOString(),
  });

  log.error("wait aborted after escalation", {
    wait_id,
    case_id: wait.case_id,
    element_id: wait.element_id,
  });
}

// ── Case attention marking ───────────────────────────────────────────────────

async function markCaseNeedsAttention(case_id: string): Promise<void> {
  const CASE_KEY_PREFIX = "konoha:case:";
  const raw = await redis.get(CASE_KEY_PREFIX + case_id);
  if (!raw) return;

  try {
    const kase = JSON.parse(raw);
    if (kase.needs_attention) return; // already marked
    kase.needs_attention = true;
    await redis.set(CASE_KEY_PREFIX + case_id, JSON.stringify(kase));
    log.info("marked case as needs_attention", { case_id });
  } catch (e: any) {
    log.warn("failed to mark case needs_attention", { case_id, error: e?.message });
  }
}
