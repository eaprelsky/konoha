/**
 * runtime.ts — Barrel re-export for all runtime modules.
 * Decomposed from monolith (issue #338).
 *
 *  runtime/event-log.ts  — event log (Redis Streams)
 *  runtime/cases.ts      — case lifecycle + work item advancement helpers
 *  runtime/work-items.ts — work item CRUD + completeWorkItem
 *  runtime/reminders.ts  — reminder CRUD + BullMQ scheduler
 *  runtime/roles.ts      — role directory CRUD
 *  runtime/documents.ts  — document template CRUD
 */
export * from "./runtime/event-log";
export * from "./runtime/cases";
export * from "./runtime/work-items";
export * from "./runtime/reminders";
export * from "./runtime/roles";
export * from "./runtime/documents";
