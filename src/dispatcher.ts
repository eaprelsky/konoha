/**
 * Task dispatcher: when a case reaches a Function node, dispatch the work item
 * to the appropriate agent (via Konoha bus) or person (via Telegram).
 */
import { redis } from "./redis";
import { listAgents, sendMessage } from "./redis";
import { isSystemRole, executeSystemFunction } from "./system-agent";
import type { WorkflowDefinition } from "./workflow-loader";
import { loadRole } from "./runtime/roles";
import type { AssignmentStrategy } from "./runtime/roles";
import { execFile } from "child_process";
import { promisify } from "util";
import { readFileSync, existsSync } from "fs";

const execFileAsync = promisify(execFile);

const DOC_KEY_PREFIX = "doc:";
const PEOPLE_CUSTOM_KEY = "people:custom";
const TRUSTED_PATH = "/opt/shared/.trusted-users.json";
const TG_SEND_SCRIPT = "/home/ubuntu/naruto-tg-send.py";

/** Load instruction text from document IDs. Falls back to the function label. */
async function loadInstructionText(docIds: string[], label: string): Promise<string> {
  if (!docIds.length) return label;
  const texts: string[] = [];
  for (const id of docIds) {
    try {
      const raw = await redis.get(DOC_KEY_PREFIX + id);
      if (raw) {
        const doc = JSON.parse(raw);
        if (doc.content) texts.push(`[${doc.name || id}]\n${doc.content}`);
      }
    } catch { /* skip missing docs */ }
  }
  return texts.length ? texts.join("\n\n") : label;
}

type PersonRecord = {
  name: string; tg_id?: number; tg_username?: string;
  position?: string; channel?: string;
};

/** Look up a person by role name (matches name or position). */
async function findPersonByRole(role: string): Promise<PersonRecord | null> {
  // Redis custom people
  try {
    const custom = await redis.hgetall(PEOPLE_CUSTOM_KEY);
    for (const val of Object.values(custom)) {
      const p: PersonRecord = JSON.parse(val);
      if (p.name === role || p.position === role) return p;
    }
  } catch { /* redis unavailable */ }

  // trusted-users.json
  try {
    if (existsSync(TRUSTED_PATH)) {
      const data = JSON.parse(readFileSync(TRUSTED_PATH, "utf-8")) as {
        owner?: { name: string; telegram_id: number; username?: string; position?: string };
        trusted?: { name: string; telegram_id: number; username?: string; position?: string }[];
      };
      const all = [data.owner, ...(data.trusted || [])].filter(Boolean) as NonNullable<typeof data.owner>[];
      for (const u of all) {
        if (u.name === role || u.position === role) {
          return { name: u.name, tg_id: u.telegram_id, tg_username: u.username || undefined };
        }
      }
    }
  } catch { /* file unavailable */ }

  return null;
}

export interface DispatchParams {
  role: string;
  label: string;
  work_item_id: string;
  case_id: string;
  process_id: string;
  element_id: string;
  docIds: string[];
  def?: WorkflowDefinition;                // full workflow def — for process context (#404)
  payload?: Record<string, unknown>;       // current case payload — forwarded to agent
}

/** Build compact process context block for an agent dispatch message (#404). */
function buildProcessContext(def: WorkflowDefinition, elementId: string): string {
  const byId = new Map(def.elements.map(e => [e.id, e]));
  const outEdges = new Map<string, string[]>();
  for (const el of def.elements) outEdges.set(el.id, []);
  for (const [from, to] of def.flow) outEdges.get(from)?.push(to);

  const predecessorIds: string[] = [];
  for (const [from, to] of def.flow) {
    if (to === elementId) predecessorIds.push(from);
  }
  const successorIds = outEdges.get(elementId) || [];

  const fmt = (id: string) => {
    const el = byId.get(id);
    return el ? `${el.label} [${el.type}]` : id;
  };

  const lines: string[] = [`Процесс: ${def.name} (${def.id})`];
  if (predecessorIds.length) lines.push(`До: ${predecessorIds.map(fmt).join(", ")}`);
  lines.push(`→ СЕЙЧАС: ${fmt(elementId)}`);
  if (successorIds.length) lines.push(`После: ${successorIds.map(fmt).join(", ")}`);

  const el = byId.get(elementId);
  if (el?.systems?.length) {
    lines.push(`Системы: ${el.systems.map(s => s.connector + (s.operation ? ` (${s.operation})` : "")).join(", ")}`);
  }
  if (el?.intent) {
    lines.push(`Цель: ${el.intent}`);
  }

  return lines.join("\n");
}

/** Count pending/running work items assigned to an agent (load indicator). */
async function agentLoad(agentId: string): Promise<number> {
  try {
    return await redis.scard(`konoha:workitems:assignee:${agentId}`);
  } catch {
    return 0;
  }
}

/** Select agent by assignment strategy (load-balancing, round-robin, broadcast, manual). */
async function selectByStrategy(
  agents: import("./redis").Agent[],
  strategy: AssignmentStrategy,
  roleId: string,
): Promise<import("./redis").Agent> {
  switch (strategy) {
    case "load-balancing": {
      const loads = await Promise.all(agents.map(a => agentLoad(a.id)));
      return agents[loads.indexOf(Math.min(...loads))];
    }
    case "round-robin": {
      const key = `konoha:role:${roleId}:rr_counter`;
      const counter = await redis.incr(key);
      return agents[(counter - 1) % agents.length];
    }
    case "broadcast":
    case "manual":
    default:
      return agents[0];
  }
}

/** Look up a person by exact ID/name (used when assignees[] contains person IDs). */
async function findPersonById(id: string): Promise<PersonRecord | null> {
  // Redis custom people
  try {
    const custom = await redis.hgetall(PEOPLE_CUSTOM_KEY);
    for (const [key, val] of Object.entries(custom)) {
      const p: PersonRecord = JSON.parse(val);
      if (key === id || p.name === id) return p;
    }
  } catch { /* redis unavailable */ }

  // trusted-users.json — match by username or name
  try {
    if (existsSync(TRUSTED_PATH)) {
      const data = JSON.parse(readFileSync(TRUSTED_PATH, "utf-8")) as {
        owner?: { name: string; telegram_id: number; username?: string; position?: string };
        trusted?: { name: string; telegram_id: number; username?: string; position?: string }[];
      };
      const all = [data.owner, ...(data.trusted || [])].filter(Boolean) as NonNullable<typeof data.owner>[];
      for (const u of all) {
        if (u.name === id || u.username === id) {
          return { name: u.name, tg_id: u.telegram_id, tg_username: u.username };
        }
      }
    }
  } catch { /* file unavailable */ }

  return null;
}

/**
 * Resolve assignee via RoleDef.assignees[] with strategy, then fall back to
 * direct name/id/capability match for backward-compatibility.
 */
async function resolveAssignee(role: string): Promise<
  | { type: "agent"; agent: import("./redis").Agent; roleId?: string; strategy?: AssignmentStrategy }
  | { type: "person"; person: PersonRecord }
  | { type: "broadcast"; agents: import("./redis").Agent[]; roleId: string }
  | null
> {
  // 1. Load RoleDef
  const roleDef = await loadRole(role).catch(() => null);

  if (roleDef && roleDef.assignees.length > 0) {
    const allAgents = await listAgents(true); // online only
    const agentMap = new Map(allAgents.map(a => [a.id, a]));

    const availableAgents = roleDef.assignees
      .map(id => agentMap.get(id))
      .filter(Boolean) as import("./redis").Agent[];

    if (availableAgents.length > 0) {
      if (roleDef.strategy === "broadcast") {
        return { type: "broadcast", agents: availableAgents, roleId: role };
      }
      const selected = await selectByStrategy(availableAgents, roleDef.strategy, role);
      return { type: "agent", agent: selected, roleId: role, strategy: roleDef.strategy };
    }

    // No online agents found — check if any assignee is a person
    for (const assigneeId of roleDef.assignees) {
      const person = await findPersonById(assigneeId);
      if (person?.tg_id) return { type: "person", person };
    }
  }

  // 2. Fallback: direct name/id/capability match (backward-compatibility)
  const agent = await findAgentDirect(role);
  if (agent) return { type: "agent", agent };

  const person = await findPersonByRole(role);
  if (person?.tg_id) return { type: "person", person };

  return null;
}

/**
 * Find agent by direct name/id match or capability (pre-M:M fallback).
 */
async function findAgentDirect(role: string): Promise<import("./redis").Agent | null> {
  const agents = await listAgents(true); // online only

  // Exact name/id match
  const exact = agents.find(a => a.id === role || a.name === role);
  if (exact) return exact;

  // Capability-based match
  const capable = agents.filter(a => a.capabilities?.includes(role));
  if (capable.length === 0) return null;
  if (capable.length === 1) return capable[0];

  // Load-aware: pick agent with fewest in-flight work items
  const loads = await Promise.all(capable.map(a => agentLoad(a.id)));
  const minLoad = Math.min(...loads);
  return capable[loads.indexOf(minLoad)];
}

/** Dispatch a work item to an agent or person based on role. Fire-and-forget safe. */
export async function dispatchWorkItem(params: DispatchParams): Promise<void> {
  const { role, label, work_item_id, case_id, process_id, element_id, docIds } = params;

  // 0. System role → system-agent handles timers, doc gen, auto-execute
  if (isSystemRole(role)) {
    await executeSystemFunction({ label, work_item_id, case_id, process_id, element_id, docIds });
    return;
  }

  const instruction = await loadInstructionText(docIds, label);
  const hasExtra = instruction !== label;

  const buildAgentText = (agentId: string, routeReason: string): string => {
    const processCtx = params.def ? buildProcessContext(params.def, element_id) : null;
    const payloadBlock = params.payload && Object.keys(params.payload).length > 0
      ? `\nДанные прогона:\n${JSON.stringify(params.payload, null, 2)}`
      : "";
    return [
      `[Задача от runtime]`,
      processCtx || `Процесс: ${process_id} | Кейс: ${case_id}`,
      processCtx ? `Прогон: ${case_id}` : "",
      `Роль: ${role} (${routeReason})`,
      `work_item_id: ${work_item_id}`,
      hasExtra ? `\nИнструкция:\n${instruction}` : `\nФункция: ${label}`,
      payloadBlock,
    ].filter(Boolean).join("\n");
  };

  const buildPersonText = (): string => {
    const lines = [
      `Новая задача: ${label}`,
      `Процесс: ${process_id}`,
      `Кейс: ${case_id}`,
      `ID: ${work_item_id}`,
    ];
    if (hasExtra) lines.push(`\n${instruction}`);
    return lines.join("\n");
  };

  // Resolve via RoleDef M:M → fallback to direct match
  const resolved = await resolveAssignee(role);

  if (resolved?.type === "broadcast") {
    // Broadcast: send to ALL online assignees
    for (const agent of resolved.agents) {
      const text = buildAgentText(agent.id, "broadcast");
      await sendMessage({ from: "runtime", to: agent.id, type: "task", text });
      console.log(`[dispatcher] broadcast task to agent "${agent.id}" for work_item ${work_item_id}`);
    }
    return;
  }

  if (resolved?.type === "agent") {
    const routeReason = resolved.strategy ? `role-m2m:${resolved.strategy}` : "direct-match";
    const text = buildAgentText(resolved.agent.id, routeReason);
    await sendMessage({ from: "runtime", to: resolved.agent.id, type: "task", text });
    console.log(`[dispatcher] sent task to agent "${resolved.agent.id}" (${routeReason}) for work_item ${work_item_id}`);
    return;
  }

  if (resolved?.type === "person") {
    const tgText = buildPersonText();
    await execFileAsync("python3", [TG_SEND_SCRIPT, String(resolved.person.tg_id), tgText])
      .then(() => console.log(`[dispatcher] telegram sent to tg_id=${resolved.person.tg_id} for work_item ${work_item_id}`))
      .catch(e => console.error(`[dispatcher] telegram send failed for work_item ${work_item_id}:`, e.message));
    return;
  }

  // No match — work item stays as manual (visible in Work Items UI)
  console.log(`[dispatcher] no dispatch target for role "${role}" — work_item ${work_item_id} stays manual`);
}
