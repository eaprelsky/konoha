/**
 * agent/crud.ts — Agent definition CRUD operations.
 * Extracted from agent-lifecycle.ts (#509).
 */

import { redis } from "../redis";
import type { AgentDef } from "./types";

const AGENT_DEF_KEY   = "konoha:agent-defs";    // hash: id → AgentDef JSON
const AGENT_STATE_KEY = "konoha:agent-states";   // hash: id → AgentState JSON
const AUDIT_STREAM    = "konoha:agent-audit";    // stream: lifecycle events

// ── Audit helper (local, also used by process.ts) ────────────────────────────

async function audit(agent_id: string, action: string, detail?: string): Promise<void> {
  const fields: string[] = ["agent_id", agent_id, "action", action, "timestamp", new Date().toISOString()];
  if (detail) fields.push("detail", detail);
  await redis.xadd(AUDIT_STREAM, "*", ...fields);
}

// ── Agent definitions ────────────────────────────────────────────────────────

export async function createAgentDef(input: Omit<AgentDef, "created_at" | "updated_at">): Promise<AgentDef> {
  const now = new Date().toISOString();
  const def: AgentDef = { ...input, created_at: now, updated_at: now };
  await redis.hset(AGENT_DEF_KEY, def.id, JSON.stringify(def));
  await audit(def.id, "created");
  return def;
}

export async function upsertAgentDef(input: Omit<AgentDef, "created_at" | "updated_at">): Promise<{ def: AgentDef; created: boolean }> {
  const existing = await getAgentDef(input.id);
  const now = new Date().toISOString();
  const def: AgentDef = existing
    ? { ...existing, ...input, id: input.id, created_at: existing.created_at, updated_at: now }
    : { ...input, created_at: now, updated_at: now };
  await redis.hset(AGENT_DEF_KEY, def.id, JSON.stringify(def));
  await audit(def.id, existing ? "updated" : "created");
  return { def, created: !existing };
}

export async function getAgentDef(id: string): Promise<AgentDef | null> {
  const raw = await redis.hget(AGENT_DEF_KEY, id);
  return raw ? JSON.parse(raw) : null;
}

export async function deleteAgentDef(id: string): Promise<void> {
  await redis.hdel(AGENT_DEF_KEY, id);
  await redis.hdel(AGENT_STATE_KEY, id);
  await audit(id, "deleted");
}

export async function listAgentDefs(): Promise<AgentDef[]> {
  const all = await redis.hgetall(AGENT_DEF_KEY);
  return Object.values(all)
    .map(v => JSON.parse(v) as AgentDef)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}
