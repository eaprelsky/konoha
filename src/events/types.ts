/**
 * events/types.ts — Shared type definitions for the event manager.
 */

export type UiStatus = "waiting" | "fired" | "error" | "manual_fallback";

export interface TimerTrigger {
  kind: "timer";
  cron: string;
}

export interface MessageTrigger {
  kind: "message";
  source: string;   // "bitrix" | "telegram" | "tracker"
  filter: Record<string, unknown>;
}

export interface ConditionTrigger {
  kind: "condition";
  data_source: string;
  query: { entity: string; filter: Record<string, unknown>; metric: string; sum_field?: string };
  operator: ">" | "<" | ">=" | "<=" | "==" | "!=";
  threshold: number;
  poll_interval: string;  // ISO 8601 duration, e.g. "PT30S"
}

export interface DelayAfterTrigger {
  kind: "delay_after";
  duration: string;   // ISO 8601 duration, e.g. "PT1H"
  ref_event?: string; // metadata only — countdown starts at subscribe time
}

export type TriggerDef =
  | TimerTrigger
  | MessageTrigger
  | ConditionTrigger
  | DelayAfterTrigger
  | { kind: string; [key: string]: unknown };

export interface Subscription {
  id: string;
  event_id: string;
  event_label?: string;      // human-readable event label from process definition
  process_id: string;
  process_name?: string;     // human-readable process name
  instance_id: string;
  trigger: TriggerDef;
  status: "active" | "cancelled";
  mode: "auto" | "manual";
  subscribed_at: string;
  next_fire_at?: string;     // computed: next scheduled fire time (timers)
  last_fired_at?: string;
  fire_count?: number;       // total number of times fired
  last_poll_at?: string;     // last condition poll time
  last_poll_result?: unknown; // last condition poll result
  error?: string;            // last error message
}
