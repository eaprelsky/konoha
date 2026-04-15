/**
 * runtime/event-waits/types.ts — EventWait type definitions.
 * Design: ADR-001 EventWait Runtime Entity (issue #491).
 */

export type EventWaitStatus =
  | "active"        // case is waiting at an event node
  | "fired"         // matching event received, case advancing
  | "cancelled"     // case cancelled or error, wait released
  | "overdue"       // deadline passed without event
  | "escalated";    // overdue + escalation triggered

export type TriggerKind =
  | "timer"         // cron / one-shot timer
  | "message"       // webhook / polling message from adapter
  | "condition"     // data query condition
  | "delay_after"   // delay after preceding event
  | "manual";       // human confirmation required

export interface EventWait {
  /** Unique ID (UUID). */
  wait_id: string;

  /** The case waiting at this event node. */
  case_id: string;

  /** Process definition ID. */
  process_id: string;

  /** The event node element ID in the process graph. */
  element_id: string;

  /** Human-readable label of the event node. */
  element_label?: string;

  /** What kind of trigger this wait expects. */
  trigger_kind: TriggerKind;

  /** Current status of the wait. */
  status: EventWaitStatus;

  /** ISO timestamp when the wait was created. */
  created_at: string;

  /** ISO timestamp when the wait was resolved (fired/cancelled). */
  resolved_at?: string;

  /** ISO deadline — if set, wait becomes overdue after this time. */
  deadline?: string;

  /** Who is responsible for confirming this event (for manual triggers). */
  assignee?: string;

  /** Linked subscription ID (if auto-triggered). */
  subscription_id?: string;

  /** How many times we've reminded about this wait. */
  reminder_count?: number;

  /** ISO timestamp of last reminder sent. */
  last_reminder_at?: string;

  /** Escalation policy — role or agent to escalate to on overdue. */
  escalation_target?: string;

  /** Output data from the triggering event (set on fire). */
  event_data?: Record<string, unknown>;
}
