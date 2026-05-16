/**
 * agent/index.ts — Barrel re-export for the agent module.
 * Decomposed from monolith agent-lifecycle.ts (#509).
 *
 *  agent/types.ts          — shared type definitions
 *  agent/llm-client-profiles.ts — LLM provider profiles (#568)
 *  agent/tool-profiles.ts  — tool/plugin profiles (#571)
 *  agent/view.ts           — split boundary composition (#569)
 *  agent/runtime.ts        — provider resolution, MCP config, launch commands
 *  agent/prompt.ts         — system prompt template + role block building
 *  agent/process.ts        — tmux management, state persistence, start/stop
 *  agent/crud.ts           — agent definition CRUD
 */
export * from "./types";
export * from "./llm-client-profiles";
export * from "./tool-profiles";
export * from "./sandbox-profiles";
export * from "./view";
export * from "./runtime";
export * from "./prompt";
export * from "./process";
export * from "./crud";
export * from "./healthcheck";
export * from "./prompt-drift";
