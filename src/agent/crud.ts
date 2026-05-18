/**
 * agent/crud.ts — Agent definition CRUD operations.
 * Extracted from agent-lifecycle.ts (#509).
 */

import { createHash } from "crypto";
import { redis } from "../redis";
import type { AgentDef, AgentRuntimeConfig, AgentTemplate } from "./types";
import { runtimeConfigFromAgentDef, templateFromAgentDef } from "./view";

const AGENT_DEF_KEY   = "konoha:agent-defs";    // hash: id → AgentDef JSON
const AGENT_TEMPLATE_KEY = "konoha:agent-templates"; // hash: id → AgentTemplate JSON
const AGENT_RUNTIME_CONFIG_KEY = "konoha:agent-runtime-configs"; // hash: id → AgentRuntimeConfig JSON
const AGENT_STATE_KEY = "konoha:agent-states";   // hash: id → AgentState JSON
const AUDIT_STREAM    = "konoha:agent-audit";    // stream: lifecycle events

export interface AgentDefUpsertOptions {
  preserveOrgDisplayFields?: boolean;
  /** Preserve runtime-config fields (model, runtime, profiles, etc.)
   *  from the existing definition when the agent already exists.
   *  Prevents seed-agents from overwriting manually configured runtime settings. */
  preserveRuntimeConfig?: boolean;
}

const ORG_OWNED_DISPLAY_FIELDS = ["name", "display_alias", "avatar_url"] as const;

const RUNTIME_PRESERVED_FIELDS = [
  "model",
  "runtime",
  "llm_client_profile",
  "fallback_runtime",
  "fallback_llm_client_profile",
  "reasoning_effort",
  "launch_strategy",
  "startup_timeout_sec",
  "env",
  "tool_profile",
  "sandbox_profile",
  "shared_mcp_allowlist",
  "codex_disable_features",
  "active_runtime_profile",
  "auto_runtime_fallback",
] as const;

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function withSystemPromptMetadata(def: AgentDef, previous: AgentDef | null, updatedBy: string): AgentDef {
  const prompt = def.system_prompt ?? "";
  const promptChanged = !previous || (previous.system_prompt ?? "") !== prompt;
  return {
    ...def,
    system_prompt_hash: sha256Text(prompt),
    system_prompt_updated_at: promptChanged ? def.updated_at : previous?.system_prompt_updated_at ?? def.updated_at,
    system_prompt_updated_by: promptChanged ? updatedBy : previous?.system_prompt_updated_by ?? "legacy",
    rendered_prompt_hash: def.rendered_prompt_hash ?? previous?.rendered_prompt_hash,
    rendered_prompt_updated_at: def.rendered_prompt_updated_at ?? previous?.rendered_prompt_updated_at,
    rendered_prompt_path: def.rendered_prompt_path ?? previous?.rendered_prompt_path,
  };
}

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
  const def: AgentDef = withSystemPromptMetadata({ ...input, created_at: now, updated_at: now }, null, "agent.create");
  await storeAgentDef(def);
  await audit(def.id, "created");
  return def;
}

export async function upsertAgentDef(
  input: Omit<AgentDef, "created_at" | "updated_at">,
  options: AgentDefUpsertOptions = {},
): Promise<{ def: AgentDef; created: boolean }> {
  const existing = await getAgentDef(input.id);
  const now = new Date().toISOString();
  let def: AgentDef = existing
    ? { ...existing, ...input, id: input.id, created_at: existing.created_at, updated_at: now }
    : { ...input, created_at: now, updated_at: now };
  if (existing && options.preserveOrgDisplayFields) {
    for (const field of ORG_OWNED_DISPLAY_FIELDS) {
      const value = existing[field];
      if (value !== undefined) {
        def[field] = value;
      }
    }
  }
  if (existing && options.preserveRuntimeConfig) {
    for (const field of RUNTIME_PRESERVED_FIELDS) {
      const value = existing[field];
      if (value !== undefined) {
        (def as unknown as Record<string, unknown>)[field] = value;
      }
    }
  }
  def = withSystemPromptMetadata(def, existing, existing ? "agent.upsert" : "agent.create");
  await storeAgentDef(def);
  await audit(def.id, existing ? "updated" : "created");
  return { def, created: !existing };
}

export async function updateAgentDef(id: string, updates: Partial<Omit<AgentDef, "id" | "created_at" | "updated_at">>): Promise<AgentDef | null> {
  const existing = await getAgentDef(id);
  if (!existing) return null;
  const providedUpdates = Object.fromEntries(
    Object.entries(updates).filter(([, value]) => value !== undefined),
  ) as Partial<Omit<AgentDef, "id" | "created_at" | "updated_at">>;
  const def: AgentDef = withSystemPromptMetadata({
    ...existing,
    ...providedUpdates,
    id,
    created_at: existing.created_at,
    updated_at: new Date().toISOString(),
  }, existing, "agent.update_profile");
  await storeAgentDef(def);
  await audit(id, "updated");
  return def;
}

export async function recordRenderedPromptMirror(agentId: string, renderedPrompt: string, mirrorPath: string): Promise<AgentDef | null> {
  const existing = await getAgentDef(agentId);
  if (!existing) return null;
  const def: AgentDef = withSystemPromptMetadata({
    ...existing,
    rendered_prompt_hash: sha256Text(renderedPrompt),
    rendered_prompt_updated_at: new Date().toISOString(),
    rendered_prompt_path: mirrorPath,
    updated_at: new Date().toISOString(),
  }, existing, existing.system_prompt_updated_by ?? "agent.prompt_mirror");
  await storeAgentDef(def);
  await audit(agentId, "prompt_mirror_written", mirrorPath);
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
