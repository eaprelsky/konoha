/**
 * agent/index.ts — Barrel re-export for the agent module.
 * Decomposed from monolith agent-lifecycle.ts (#509).
 *
 *  agent/types.ts    — shared type definitions
 *  agent/runtime.ts  — provider resolution, MCP config, launch commands
 *  agent/prompt.ts   — system prompt template + role block building
 *  agent/process.ts  — tmux management, state persistence, start/stop
 *  agent/crud.ts     — agent definition CRUD
 */
export * from "./types";
export * from "./runtime";
export * from "./prompt";
export * from "./process";
export * from "./crud";
