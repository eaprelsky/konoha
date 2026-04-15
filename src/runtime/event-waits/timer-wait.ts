/**
 * runtime/event-waits/timer-wait.ts — TimerWait: time-based process wait.
 *
 * TimerWait is a specialization of EventWait where the trigger is deterministic
 * time rather than an external message or human action.
 *
 * Key distinction from reminders:
 *   - TimerWait  = process-time semantics. When wake_at is reached, the case
 *                  advances automatically. This is a state machine transition.
 *   - Reminders  = notification semantics. Reminders inform agents/humans that
 *                  a wait is ongoing or overdue. They never advance the process.
 *
 * Lifecycle:
 *   active  → (wake_at reached) → fired    → case auto-advances
 *   active  → (deadline passed) → overdue  → escalation may trigger
 *   overdue → (escalation runs) → escalated
 *   active  → (case cancelled)  → cancelled
 */

import { randomUUID } from "crypto";
import { redis } from "../../redis";
import { createLogger } from "../../logger";
import { loadEventWait, updateEventWaitStatus } from "./index";
import type { EventWait, EventWaitStatus, TriggerKind } from "./types";

const log = createLogger("runtime:timer-wait");

const TIMER_WAIT_IDX_DUE = "konoha:timer-waits:due";

// ── Timer types ──────────────────────────────────────────────────────────────

/** How the timer fires. */
export type TimerType =
  | "delay"      // relative: fire after `duration` from creation
  | "one_shot"   // absolute: fire at `wake_at` exactly once
  | "cron";      // recurring: fire on cron schedule (future)

/** Escalation step definition. */
export interface EscalationStep {
  /** Delay after previous step (or after overdue transition) in seconds. */
  delay_seconds: number;
  /** Role or agent to notify. */
  target: string;
  /** What to do: notify, reassign, auto-complete, abort. */
  action: "notify" | "reassign" | "auto_complete" | "abort";
}

/** Escalation policy attached to a TimerWait. */
export interface EscalationPolicy {
  /** Ordered escalation steps. */
  steps: EscalationStep[];
  /** Maximum escalation depth before forcing resolution. */
  max_depth?: number;
}

// ── TimerWait interface ──────────────────────────────────────────────────────

/**
 * TimerWait extends EventWait with time-specific fields.
 *
 * Stored as a regular EventWait in Redis (same key structure), with additional
 * fields that only timer-kind waits use. The trigger_kind is always "timer".
 */
export interface TimerWait extends EventWait {
  trigger_kind: "timer";

  /** When this timer should fire (ISO 8601 timestamp). Required for one_shot. */
  wake_at: string;

  /** Timer type: delay, one_shot, or cron. */
  timer_type: TimerType;

  /** ISO 8601 duration string (e.g. "PT5M") for delay-type timers. */
  duration?: string;

  /** Escalation policy for overdue timers. */
  escalation_policy?: EscalationPolicy;

  /** Current escalation step index (0 = first, incremented on each step). */
  escalation_step?: number;

  /** Cron expression for recurring timers (future). */
  cron_expression?: string;

  /** Whether this timer auto-advances the case on fire (default: true). */
  auto_advance?: boolean;
}

// ── Lifecycle transitions ────────────────────────────────────────────────────

export const TIMER_TRANSITIONS: Record<EventWaitStatus, EventWaitStatus[]> = {
  active:     ["fired", "cancelled", "overdue"],
  fired:      [],                           // terminal
  cancelled:  [],                           // terminal
  overdue:    ["escalated", "fired", "cancelled"],
  escalated:  ["fired", "cancelled"],
};

export function canTransitionTimer(from: EventWaitStatus, to: EventWaitStatus): boolean {
  return TIMER_TRANSITIONS[from]?.includes(to) ?? false;
}

// ── Create ────────────────────────────────────────────────────────────────────

export async function createTimerWait(params: {
  case_id: string;
  process_id: string;
  element_id: string;
  element_label?: string;
  timer_type: TimerType;
  wake_at: string;
  duration?: string;
  deadline?: string;
  assignee?: string;
  escalation_policy?: EscalationPolicy;
  auto_advance?: boolean;
  cron_expression?: string;
}): Promise<TimerWait> {
  const tw: TimerWait = {
    wait_id: randomUUID(),
    case_id: params.case_id,
    process_id: params.process_id,
    element_id: params.element_id,
    element_label: params.element_label,
    trigger_kind: "timer",
    status: "active",
    created_at: new Date().toISOString(),
    wake_at: params.wake_at,
    timer_type: params.timer_type,
    duration: params.duration,
    deadline: params.deadline,
    assignee: params.assignee,
    escalation_policy: params.escalation_policy,
    escalation_step: 0,
    auto_advance: params.auto_advance ?? true,
    cron_expression: params.cron_expression,
  };

  await saveTimerWait(tw);
  await indexTimerWaitByDueDate(tw);
  log.info("timer wait created", {
    wait_id: tw.wait_id,
    case_id: tw.case_id,
    element_id: tw.element_id,
    timer_type: tw.timer_type,
    wake_at: tw.wake_at,
  });
  return tw;
}

// ── Read ──────────────────────────────────────────────────────────────────────

export async function loadTimerWait(wait_id: string): Promise<TimerWait | null> {
  const ew = await loadEventWait(wait_id);
  if (!ew || ew.trigger_kind !== "timer") return null;
  return ew as TimerWait;
}

/** Find all timer waits whose wake_at has passed (ready to fire). */
export async function loadDueTimerWaits(): Promise<TimerWait[]> {
  const now = Date.now();
  const ids = await redis.zrangebyscore(TIMER_WAIT_IDX_DUE, "-inf", now);
  const waits = await Promise.all(ids.map(id => loadTimerWait(id as string)));
  return waits.filter((w): w is TimerWait => w !== null && w.status === "active");
}

// ── Transitions ──────────────────────────────────────────────────────────────

/** Fire a timer wait — the wake_at has been reached. */
export async function fireTimerWait(wait_id: string): Promise<TimerWait | null> {
  const tw = await loadTimerWait(wait_id);
  if (!tw) return null;
  if (!canTransitionTimer(tw.status, "fired")) {
    log.warn("timer fire: invalid transition", { wait_id, from: tw.status });
    return null;
  }
  await updateEventWaitStatus(wait_id, "fired");
  await removeTimerWaitFromDueIndex(wait_id);
  log.info("timer wait fired", { wait_id, case_id: tw.case_id, element_id: tw.element_id });
  return loadTimerWait(wait_id);
}

/** Mark timer as overdue — deadline passed without fire. */
export async function markTimerOverdue(wait_id: string): Promise<TimerWait | null> {
  const tw = await loadTimerWait(wait_id);
  if (!tw) return null;
  if (!canTransitionTimer(tw.status, "overdue")) {
    log.warn("timer overdue: invalid transition", { wait_id, from: tw.status });
    return null;
  }
  await updateEventWaitStatus(wait_id, "overdue");
  log.info("timer wait overdue", { wait_id, case_id: tw.case_id });
  return loadTimerWait(wait_id);
}

/** Run the next escalation step for an overdue timer. */
export async function escalateTimerWait(wait_id: string): Promise<TimerWait | null> {
  const tw = await loadTimerWait(wait_id);
  if (!tw) return null;
  if (!canTransitionTimer(tw.status, "escalated")) {
    log.warn("timer escalate: invalid transition", { wait_id, from: tw.status });
    return null;
  }
  const nextStep = (tw.escalation_step ?? 0) + 1;
  await updateEventWaitStatus(wait_id, "escalated");

  const updated = await loadTimerWait(wait_id);
  if (updated) {
    updated.escalation_step = nextStep;
    await saveTimerWait(updated);
  }

  const policy = tw.escalation_policy;
  const step = policy?.steps[Math.min(nextStep - 1, (policy?.steps.length ?? 1) - 1)];
  log.info("timer wait escalated", {
    wait_id,
    case_id: tw.case_id,
    step: nextStep,
    action: step?.action,
    target: step?.target,
  });
  return loadTimerWait(wait_id);
}

// ── Persistence helpers ──────────────────────────────────────────────────────

async function saveTimerWait(tw: TimerWait): Promise<void> {
  const key = `event-wait:${tw.wait_id}`;
  await redis.set(key, JSON.stringify(tw));

  // Maintain case index (reuse EventWait index structure)
  await redis.sadd(`konoha:event-waits:case:${tw.case_id}`, tw.wait_id);

  // Status index
  await redis.sadd(`konoha:event-waits:status:${tw.status}`, tw.wait_id);

  // Active index
  if (tw.status === "active") {
    await redis.sadd("konoha:event-waits:active", tw.wait_id);
  } else {
    await redis.srem("konoha:event-waits:active", tw.wait_id);
  }
}

async function indexTimerWaitByDueDate(tw: TimerWait): Promise<void> {
  const score = new Date(tw.wake_at).getTime();
  await redis.zadd(TIMER_WAIT_IDX_DUE, score, tw.wait_id);
}

async function removeTimerWaitFromDueIndex(wait_id: string): Promise<void> {
  await redis.zrem(TIMER_WAIT_IDX_DUE, wait_id);
}

// ── Tick function (called by scheduler) ───────────────────────────────────────

/**
 * Process all due timer waits. Called periodically by the timer scheduler.
 * For each due timer: fire it, then optionally auto-advance the case.
 *
 * Returns the list of fired timer waits with their case IDs for caller
 * to trigger case advancement.
 */
export async function tickTimerWaits(): Promise<Array<{
  wait_id: string;
  case_id: string;
  process_id: string;
  element_id: string;
  auto_advance: boolean;
}>> {
  const due = await loadDueTimerWaits();
  const results: Array<{
    wait_id: string;
    case_id: string;
    process_id: string;
    element_id: string;
    auto_advance: boolean;
  }> = [];

  for (const tw of due) {
    const fired = await fireTimerWait(tw.wait_id);
    if (fired) {
      results.push({
        wait_id: fired.wait_id,
        case_id: fired.case_id,
        process_id: fired.process_id,
        element_id: fired.element_id,
        auto_advance: fired.auto_advance ?? true,
      });
    }
  }

  if (results.length > 0) {
    log.info("timer tick: fired waits", { count: results.length });
  }
  return results;
}
