/**
 * event-manager.ts — Backward-compatible re-export shim.
 * The implementation has been split into src/events/ for maintainability (issue #447).
 * All existing imports from this file continue to work unchanged.
 */

export type { TimerTrigger, MessageTrigger, ConditionTrigger, DelayAfterTrigger, TriggerDef, Subscription } from "./events/types";
export { restoreSubscriptions, createSubscriptionProgrammatic, cancelSubscriptionsByInstance } from "./events/subscriptions";
export { startDelayWorker } from "./events/delay-worker";
export { registerEventManagerRoutes } from "./events/routes";
