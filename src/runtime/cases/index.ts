/**
 * runtime/cases/index.ts — Barrel re-export for the cases module.
 * Decomposed from monolith cases.ts (#507).
 *
 *  runtime/cases/types.ts         — Case/WorkItem type definitions
 *  runtime/cases/persistence.ts   — Redis key defs, PG converters, save/load
 *  runtime/cases/advancement.ts   — State machine: advanceCase, advancePastJoin
 *  runtime/cases/crud.ts          — Public API: create, get, list, events
 */
export * from "./types";
export * from "./persistence";
export * from "./advancement";
export * from "./crud";
