/**
 * agent/prompt.ts — System prompt template rendering + role block building.
 * Extracted from agent-lifecycle.ts (#509).
 */

import { redis } from "../redis";
import { getBranding } from "../routes/audit";
import { getWorkflow } from "../workflow-loader";
import { formatAgentModel } from "./runtime";
import type { AgentDef } from "./types";

// ── System template ──────────────────────────────────────────────────────────

const SYSTEM_TEMPLATE = `\
# System Instructions (managed by Konoha — do not edit)

## Identity
- Agent ID: {{id}}
- Agent Name: {{name}}
- Agent Display Alias: {{display_alias}}
- Model: {{model}}
- Language: Russian (communicate in Russian unless overridden in user instructions)

## Startup sequence
1. source /home/ubuntu/.agent-env
2. Read /opt/shared/agent-memory/MEMORY.md, then read only the files listed under \`Startup Core\`. Use other linked memory files on demand.
3. Register on Konoha bus: konoha_register(id={{id}}, name={{name}}, display_alias={{display_alias}}, model={{model}})
4. Read your personal memory if it exists: /opt/shared/agent-memory/{{id}}/MEMORY.md
5. Wait for tasks — watchdog delivers them via Konoha bus

## Konoha Bus
- HTTP API: http://127.0.0.1:3200
- Token: stored in KONOHA_TOKEN env var
- Use MCP tools: konoha_send, konoha_read, konoha_register, konoha_heartbeat
- Messages arrive via watchdog — do NOT poll manually

## Watchdog behavior
When you receive a task via watchdog injection, process it and respond via konoha_send.
Session cleanup fires every 2h — save work-state and do /new when requested.

---
# User Instructions`;

export function renderSystemTemplate(def: Pick<AgentDef, "id" | "name" | "display_alias" | "model" | "runtime">): string {
  const displayAlias = def.display_alias ?? def.name;
  return SYSTEM_TEMPLATE
    .replace(/{{id}}/g, def.id)
    .replace(/{{name}}/g, def.name)
    .replace(/{{display_alias}}/g, displayAlias)
    .replace(/{{model}}/g, formatAgentModel(def));
}

/**
 * Build Layer 3 (role blocks) for this agent's composite system prompt.
 * For each role where this agent is an assignee, extracts assigned functions
 * from associated workflows and formats them as readable instructions.
 */
export async function buildRoleBlocks(agentId: string): Promise<string> {
  const roleIds = await redis.zrange("konoha:roles:all", 0, -1).catch(() => [] as string[]);
  if (roleIds.length === 0) return "";

  const blocks: string[] = [];

  for (const roleId of roleIds) {
    const raw = await redis.get(`role:${roleId}`).catch(() => null);
    if (!raw) continue;
    const role = JSON.parse(raw) as { role_id: string; name: string; assignees: string[]; description?: string };
    if (!role.assignees.includes(agentId)) continue;

    const workflowIds = await redis.smembers(`konoha:role:${roleId}:workflows`).catch(() => [] as string[]);
    if (workflowIds.length === 0) continue;

    const roleLines: string[] = [];
    let hasAssignedFunctions = false;

    for (const wfId of workflowIds) {
      const wf = await getWorkflow(wfId).catch(() => null);
      if (!wf) continue;

      const functions = wf.elements.filter(el => el.type === "function" && el.role === roleId);
      if (functions.length === 0) continue;
      if (!hasAssignedFunctions) {
        roleLines.push(`## Role: ${role.name}`);
        if (role.description) roleLines.push(role.description);
        roleLines.push("\nYou perform the following functions in business processes:\n");
        hasAssignedFunctions = true;
      }

      roleLines.push(`### Process: ${wf.name}`);

      const outEdges = new Map<string, string[]>();
      const inEdges = new Map<string, string[]>();
      for (const el of wf.elements) { outEdges.set(el.id, []); inEdges.set(el.id, []); }
      for (const [from, to] of wf.flow) {
        outEdges.get(from)?.push(to as string);
        inEdges.get(to as string)?.push(from);
      }
      const byId = new Map(wf.elements.map(e => [e.id, e]));

      for (const fn of functions) {
        roleLines.push(`\n#### ${fn.label}`);

        const inputEvents = (inEdges.get(fn.id) ?? [])
          .map(id => byId.get(id))
          .filter(el => el?.type === "event");
        if (inputEvents.length > 0) {
          roleLines.push(`- Triggered by: ${inputEvents.map(e => e!.label).join(", ")}`);
        }

        const outputEvents = (outEdges.get(fn.id) ?? [])
          .map(id => byId.get(id))
          .filter(el => el?.type === "event");
        if (outputEvents.length > 0) {
          roleLines.push(`- Produces: ${outputEvents.map(e => e!.label).join(", ")}`);
        }

        if (fn.documents?.length) roleLines.push(`- Documents: ${fn.documents.join(", ")}`);
        if (fn.systems?.length) roleLines.push(`- Systems: ${fn.systems.map(s => s.connector).join(", ")}`);
        if (fn.intent) roleLines.push(`- Goal: ${fn.intent}`);
      }
    }

    if (hasAssignedFunctions) {
      blocks.push(roleLines.join("\n"));
    }
  }

  if (blocks.length === 0) return "";
  return "\n\n---\n# Role Assignments\n\n" + blocks.join("\n\n");
}

/**
 * Builds the complete agent system prompt: system template + user instructions + role blocks + skill snippets.
 * Used by startAgent() and GET /agents/:id/system-template.
 */
export async function buildSystemPrompt(agentId: string, def: Pick<AgentDef, "id" | "name" | "display_alias" | "model" | "runtime" | "system_prompt" | "capabilities">): Promise<string> {
  // Canonical product name is stable; aliases/callsigns are instance-specific.
  const branding = await getBranding().catch(() => null);
  const displayName = def.name;
  const alias = branding?.agent_display_names?.[agentId] ?? def.display_alias ?? def.name;

  const base = renderSystemTemplate({ ...def, name: displayName });
  const userInstructions = (def.system_prompt?.trim() ?? "")
    .replace(/\{display_name\}/g, displayName)
    .replace(/\{alias\}/g, alias);
  const roleBlocks = await buildRoleBlocks(agentId);

  let skillSnippets = "";
  if (def.capabilities && def.capabilities.length > 0) {
    const snippets: string[] = [];
    for (const skillId of def.capabilities) {
      const raw = await redis.get(`konoha:skill:${skillId}`).catch(() => null);
      if (raw) {
        const skill = JSON.parse(raw) as { prompt_snippet?: string; name?: string };
        if (skill.prompt_snippet?.trim()) {
          snippets.push(`## Skill: ${skill.name || skillId}\n${skill.prompt_snippet.trim()}`);
        }
      }
    }
    if (snippets.length > 0) skillSnippets = "\n\n" + snippets.join("\n\n");
  }

  return base + "\n" + userInstructions + roleBlocks + skillSnippets;
}
