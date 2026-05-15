/**
 * assistant-actions.ts — routing for assistant_act() calls (closes #294)
 *
 * Responsibilities:
 * - Check autonomy matrix before executing any action
 * - Write every action attempt to konoha:audit Redis stream
 * - Provide a typed interface for all assistant_act() types
 */

import { redis, sendMessage } from "./redis";
import { silentCatch, createLogger } from "./logger";

const log = createLogger("assistant-actions");
import { randomUUID } from "crypto";
import { execSync } from "child_process";

// ── Autonomy Matrix ────────────────────────────────────────────────────────────

export type AutonomyLevel = "auto" | "confirm" | "disabled";

export const AUTONOMY_KEY = "konoha:config:autonomy";

/** Complete mapping from legacy snake_case action IDs to canonical {scope}.{verb} format */
const LEGACY_TO_CANONICAL_ACTION: Record<string, string> = {
  // Issue
  issue_create: "issue.create",
  issue_label: "issue.label",

  // Workflow
  workflow_create: "workflow.create",
  workflow_update: "workflow.update",
  workflow_delete: "workflow.delete",
  workflow_list: "workflow.list",
  workflow_get: "workflow.get",

  // Element
  element_add: "element.add",
  element_update: "element.update",
  element_remove: "element.remove",

  // Flow
  flow_add: "flow.add",
  flow_remove: "flow.remove",

  // Trigger
  trigger_set: "trigger.set",
  trigger_resolve: "trigger.resolve",

  // Case
  case_start: "case.start",
  case_get: "case.get",
  case_list: "case.list",
  case_close: "case.close",
  event_confirm: "event.confirm",

  // Work item
  workitem_complete: "workitem.complete",
  workitem_create: "workitem.create",
  workitem_update: "workitem.update",
  workitem_list: "workitem.list",
  workitem_cancel: "workitem.cancel",

  // Role
  role_create: "role.create",
  role_list: "role.list",
  role_update: "role.update",
  role_delete: "role.delete",

  // Agent
  agent_register: "agent.register",
  agent_start: "agent.start",
  agent_stop: "agent.stop",
  agent_restart: "agent.restart",
  agent_deploy: "agent.deploy",

  // Subscription
  subscription_create: "subscription.create",
  subscription_cancel: "subscription.cancel",
  subscription_list: "subscription.list",

  // Reminder
  reminder_create: "reminder.create",
  reminder_list: "reminder.list",
  reminder_update_status: "reminder.update_status",
  reminder_delete: "reminder.delete",

  // Message
  message_send: "message.send",
  message_read: "message.read",

  // Audit / Knowledge
  audit_read: "audit.read",
  knowledge_tree: "knowledge.tree",
  knowledge_read: "knowledge.read",
  knowledge_search: "knowledge.search",

  // Legacy non-standard
  data_delete: "data.delete",
};

/** Self-mapping: canonical IDs map to themselves so canonicalActionType is idempotent */
for (const id of Object.keys(LEGACY_TO_CANONICAL_ACTION)) {
  const canonical = LEGACY_TO_CANONICAL_ACTION[id];
  if (!LEGACY_TO_CANONICAL_ACTION[canonical]) {
    LEGACY_TO_CANONICAL_ACTION[canonical] = canonical;
  }
}

export function canonicalActionType(actionType: string): string {
  return LEGACY_TO_CANONICAL_ACTION[actionType] ?? actionType;
}

/** Default autonomy levels per action type */
const AUTONOMY_DEFAULTS: Record<string, AutonomyLevel> = {
  "issue.create":    "auto",
  "issue.label":     "auto",
  "case.start":      "auto",
  "workflow.create": "confirm",
  "workflow.delete": "confirm",
  "data.delete":     "confirm",  // HARDCODED — never overridable
  "agent.restart":   "confirm",
  "agent.deploy":    "confirm",
  highlight:         "auto",
  navigate:          "auto",
  search:            "auto",
};

/** Permanently enforced levels — cannot be changed via UI */
const HARDCODED: Record<string, AutonomyLevel> = {
  "data.delete": "confirm",
};

export async function getAutonomyMatrix(): Promise<Record<string, AutonomyLevel>> {
  const stored = await redis.hgetall(AUTONOMY_KEY).catch(() => ({}));
  const result: Record<string, AutonomyLevel> = { ...AUTONOMY_DEFAULTS };
  for (const [k, v] of Object.entries(stored || {})) {
    if (v === "auto" || v === "confirm" || v === "disabled") {
      result[canonicalActionType(k)] = v as AutonomyLevel;
    }
  }
  // Re-apply hardcoded overrides
  Object.assign(result, HARDCODED);
  return result;
}

export async function setAutonomyLevel(actionType: string, level: AutonomyLevel): Promise<void> {
  const canonical = canonicalActionType(actionType);
  if (HARDCODED[canonical] !== undefined) {
    throw new Error(`Action "${actionType}" autonomy level is hardcoded and cannot be changed`);
  }
  await redis.hset(AUTONOMY_KEY, canonical, level);
}

export async function checkAutonomy(actionType: string): Promise<AutonomyLevel> {
  const matrix = await getAutonomyMatrix();
  return matrix[canonicalActionType(actionType)] ?? "confirm";
}

// ── Audit Log ──────────────────────────────────────────────────────────────────

export const AUDIT_STREAM = "konoha:audit";
const AUDIT_MAX_LEN = 10000;

export interface AuditEntry {
  timestamp: string;
  session_id: string;
  action_type: string;
  parameters: string;
  args_summary?: string;
  result: "ok" | "blocked" | "error" | "requires_confirm";
  agent_chain: string;
  error?: string;
}

export async function auditLog(entry: AuditEntry): Promise<void> {
  const fields: string[] = [];
  for (const [k, v] of Object.entries(entry)) {
    if (v !== undefined) fields.push(k, String(v));
  }
  await redis.xadd(AUDIT_STREAM, "MAXLEN", "~", AUDIT_MAX_LEN, "*", ...fields).catch(e => {
    log.error("audit write error", { error: e.message });
  });
}

export async function readAuditLog(opts: {
  fromDate?: string;
  toDate?: string;
  actionType?: string;
  agent?: string;
  limit?: number;
}): Promise<AuditEntry[]> {
  const limit = opts.limit ?? 100;
  const raw = await redis.xrevrange(AUDIT_STREAM, "+", "-", "COUNT", limit).catch(() => []);

  const entries: AuditEntry[] = raw.map(([, fields]) => {
    const obj: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
    return obj as unknown as AuditEntry;
  });

  return entries.filter(e => {
    if (opts.actionType && e.action_type !== opts.actionType) return false;
    if (opts.agent && !e.agent_chain.includes(opts.agent)) return false;
    if (opts.fromDate && e.timestamp < opts.fromDate) return false;
    if (opts.toDate && e.timestamp > opts.toDate) return false;
    return true;
  });
}

// ── GitHub Issue Creation ──────────────────────────────────────────────────────

export interface CreateIssueParams {
  title: string;
  body: string;
  priority?: "priority:p0" | "priority:p1" | "priority:p2" | "priority:p3";
  labels?: string[];
  session_id?: string;
  agent_chain?: string;
}

export interface CreateIssueResult {
  number: number;
  url: string;
  requires_confirm?: boolean;
}

export async function assistantCreateIssue(params: CreateIssueParams): Promise<CreateIssueResult> {
  const sessionId = params.session_id ?? randomUUID();
  const agentChain = params.agent_chain ?? "assistant";
  const autonomy = await checkAutonomy("issue.create");

  if (autonomy === "disabled") {
    await auditLog({
      timestamp: new Date().toISOString(),
      session_id: sessionId,
        action_type: "issue.create",
      parameters: JSON.stringify({ title: params.title, priority: params.priority }),
      result: "blocked",
      agent_chain: agentChain,
    });
    throw new Error("issue.create is disabled in autonomy matrix");
  }

  if (autonomy === "confirm") {
    await auditLog({
      timestamp: new Date().toISOString(),
      session_id: sessionId,
        action_type: "issue.create",
      parameters: JSON.stringify({ title: params.title, priority: params.priority }),
      result: "requires_confirm",
      agent_chain: agentChain,
    });
    return { number: 0, url: "", requires_confirm: true };
  }

  // autonomy = "auto" — proceed
  const ghToken = process.env.GH_TOKEN ?? "";
  const repo = process.env.KONOHA_REPO ?? "eaprelsky/konoha";
  const allLabels = [...(params.labels ?? [])];
  if (params.priority) allLabels.push(params.priority);

  const labelArgs = allLabels.map(l => `--label "${l}"`).join(" ");
  const bodyEscaped = params.body.replace(/'/g, "'\\''");
  const titleEscaped = params.title.replace(/'/g, "'\\''");

  let number = 0;
  let url = "";
  let result: AuditEntry["result"] = "ok";
  let errMsg: string | undefined;

  try {
    const out = execSync(
      `GH_TOKEN=${ghToken} gh issue create --repo ${repo} --title '${titleEscaped}' --body '${bodyEscaped}' ${labelArgs}`,
      { encoding: "utf-8", timeout: 15000 },
    ).trim();

    const match = out.match(/\/issues\/(\d+)/);
    if (match) {
      number = parseInt(match[1]);
      url = out;
    }

    // Notify Naruto for P0/P1
    const priority = params.priority ?? "";
    if (priority.startsWith("priority:p0") || priority.startsWith("priority:p1")) {
      await sendMessage({
        from: "assistant",
        to: "naruto",
        type: "event",
        text: `[Assistant] Создан ${priority} issue #${number}: ${params.title}\n${url}`,
      }).catch(silentCatch("assistant action fire-and-forget"));
    }
  } catch (e: any) {
    result = "error";
    errMsg = e.message;
    throw e;
  } finally {
    await auditLog({
      timestamp: new Date().toISOString(),
      session_id: sessionId,
      action_type: "issue.create",
      parameters: JSON.stringify({ title: params.title, priority: params.priority }),
      result,
      agent_chain: agentChain,
      error: errMsg,
    });
  }

  return { number, url };
}
