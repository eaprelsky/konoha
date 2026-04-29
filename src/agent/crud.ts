/**
 * agent/crud.ts — Agent definition CRUD operations.
 * Extracted from agent-lifecycle.ts (#509).
 */

import { redis } from "../redis";
import type { AgentDef, AgentRuntimeConfig, AgentTemplate } from "./types";
import { runtimeConfigFromAgentDef, templateFromAgentDef } from "./view";

const AGENT_DEF_KEY   = "konoha:agent-defs";    // hash: id → AgentDef JSON
const AGENT_TEMPLATE_KEY = "konoha:agent-templates"; // hash: id → AgentTemplate JSON
const AGENT_RUNTIME_CONFIG_KEY = "konoha:agent-runtime-configs"; // hash: id → AgentRuntimeConfig JSON
const AGENT_STATE_KEY = "konoha:agent-states";   // hash: id → AgentState JSON
const AUDIT_STREAM    = "konoha:agent-audit";    // stream: lifecycle events

// ── Audit helper (local, also used by process.ts) ────────────────────────────

async function audit(agent_id: string, action: string, detail?: string): Promise<void> {
  const fields: string[] = ["agent_id", agent_id, "action", action, "timestamp", new Date().toISOString()];
  if (detail) fields.push("detail", detail);
  await redis.xadd(AUDIT_STREAM, "*", ...fields);
}

// ── Agent definitions ────────────────────────────────────────────────────────

function composeAgentDef(template: AgentTemplate, runtimeConfig: AgentRuntimeConfig): AgentDef {
  return {
    ...template,
    ...runtimeConfig,
    id: template.id,
    name: template.name,
    created_at: template.created_at,
    updated_at: template.updated_at,
  };
}

async function storeAgentDef(def: AgentDef): Promise<void> {
  await redis
    .multi()
    .hset(AGENT_DEF_KEY, def.id, JSON.stringify(def))
    .hset(AGENT_TEMPLATE_KEY, def.id, JSON.stringify(templateFromAgentDef(def)))
    .hset(AGENT_RUNTIME_CONFIG_KEY, def.id, JSON.stringify(runtimeConfigFromAgentDef(def)))
    .exec();
}

async function getSplitAgentDef(id: string): Promise<AgentDef | null> {
  const [templateRaw, runtimeConfigRaw] = await Promise.all([
    redis.hget(AGENT_TEMPLATE_KEY, id),
    redis.hget(AGENT_RUNTIME_CONFIG_KEY, id),
  ]);
  if (!templateRaw || !runtimeConfigRaw) return null;
  return composeAgentDef(
    JSON.parse(templateRaw) as AgentTemplate,
    JSON.parse(runtimeConfigRaw) as AgentRuntimeConfig,
  );
}

export async function createAgentDef(input: Omit<AgentDef, "created_at" | "updated_at">): Promise<AgentDef> {
  const now = new Date().toISOString();
  const def: AgentDef = { ...input, created_at: now, updated_at: now };
  await storeAgentDef(def);
  await audit(def.id, "created");
  return def;
}

export async function upsertAgentDef(input: Omit<AgentDef, "created_at" | "updated_at">): Promise<{ def: AgentDef; created: boolean }> {
  const existing = await getAgentDef(input.id);
  const now = new Date().toISOString();
  const def: AgentDef = existing
    ? { ...existing, ...input, id: input.id, created_at: existing.created_at, updated_at: now }
    : { ...input, created_at: now, updated_at: now };
  await storeAgentDef(def);
  await audit(def.id, existing ? "updated" : "created");
  return { def, created: !existing };
}

export async function updateAgentDef(id: string, updates: Partial<Omit<AgentDef, "id" | "created_at" | "updated_at">>): Promise<AgentDef | null> {
  const existing = await getAgentDef(id);
  if (!existing) return null;
  const def: AgentDef = {
    ...existing,
    ...updates,
    id,
    created_at: existing.created_at,
    updated_at: new Date().toISOString(),
  };
  await storeAgentDef(def);
  await audit(id, "updated");
  return def;
}

export async function getAgentDef(id: string): Promise<AgentDef | null> {
  const raw = await redis.hget(AGENT_DEF_KEY, id);
  if (raw) return JSON.parse(raw) as AgentDef;
  return getSplitAgentDef(id);
}

export async function deleteAgentDef(id: string): Promise<void> {
  await redis
    .multi()
    .hdel(AGENT_DEF_KEY, id)
    .hdel(AGENT_TEMPLATE_KEY, id)
    .hdel(AGENT_RUNTIME_CONFIG_KEY, id)
    .hdel(AGENT_STATE_KEY, id)
    .exec();
  await audit(id, "deleted");
}

export async function listAgentDefs(): Promise<AgentDef[]> {
  const [legacy, templates, runtimeConfigs] = await Promise.all([
    redis.hgetall(AGENT_DEF_KEY),
    redis.hgetall(AGENT_TEMPLATE_KEY),
    redis.hgetall(AGENT_RUNTIME_CONFIG_KEY),
  ]);
  const byId = new Map<string, AgentDef>();
  for (const value of Object.values(legacy)) {
    const def = JSON.parse(value) as AgentDef;
    byId.set(def.id, def);
  }
  for (const [id, templateRaw] of Object.entries(templates)) {
    if (byId.has(id)) continue;
    const runtimeConfigRaw = runtimeConfigs[id];
    if (!runtimeConfigRaw) continue;
    byId.set(id, composeAgentDef(
      JSON.parse(templateRaw) as AgentTemplate,
      JSON.parse(runtimeConfigRaw) as AgentRuntimeConfig,
    ));
  }
  return Array.from(byId.values())
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export async function backfillAgentDefSplitStores(): Promise<{ total: number; backfilled: number; splitOnly: number }> {
  const [legacy, templates] = await Promise.all([
    redis.hgetall(AGENT_DEF_KEY),
    redis.hgetall(AGENT_TEMPLATE_KEY),
  ]);
  let backfilled = 0;
  for (const [id, value] of Object.entries(legacy)) {
    if (templates[id]) continue;
    await storeAgentDef(JSON.parse(value) as AgentDef);
    backfilled += 1;
  }
  const splitOnly = Object.keys(templates).filter(id => !legacy[id]).length;
  return { total: Object.keys(legacy).length, backfilled, splitOnly };
}
