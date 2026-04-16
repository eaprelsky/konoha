/**
 * assistant-response.ts — Canonical server-side response normalization (#528, #527)
 *
 * Transforms raw LLM output into a structured AssistantResponse envelope.
 * The frontend never receives raw LLM text — only normalized responses
 * with clean text and structured action results.
 *
 * This eliminates the root cause of raw JSON leaking to users (ADR-002 #525):
 *  - LLM output is parsed server-side
 *  - Actions are executed server-side via act-envelope spine (#527)
 *  - Only clean results reach the frontend
 */

import { executeAction, classifyAction } from "./act-envelope";
import type { ActEnvelope } from "./act-envelope";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AssistantAction {
  /** Action ID from the action registry */
  action: string;
  /** Parameters for the action */
  params: Record<string, unknown>;
  /** Execution status */
  status: "executed" | "needs_confirm" | "failed" | "skipped";
  /** Human-readable description of what was done */
  description: string;
  /** Result data (e.g. created workflow id) */
  result?: Record<string, unknown>;
  /** Error message if status is "failed" */
  error?: string;
}

export interface AssistantResponse {
  /** Clean human-readable reply text — never raw JSON */
  reply: string;
  /** Chat session ID */
  chat_id: string;
  /** Schema patch for the current workflow (if editing) */
  schema_patch: unknown | null;
  /** Newly created workflow (if any) */
  created_workflow: { id: string; name: string; [key: string]: unknown } | null;
  /** Actions executed during this response */
  actions_taken: AssistantAction[];
  /** UI actions (highlights, etc.) */
  ui_actions: UiAction[];
}

export interface UiAction {
  type: "highlight" | "navigate" | "notify";
  [key: string]: unknown;
}

export interface NormalizeOptions {
  /** Chat session ID */
  chat_id: string;
  /** Whether to execute workflow creation actions (default: true) */
  execute_actions?: boolean;
  /** Agent ID for audit logging */
  agent_id?: string;
  /** Session ID for audit trail */
  session_id?: string;
}

// ── Normalization ─────────────────────────────────────────────────────────────

/**
 * Parse raw LLM text into a structured response, executing actions server-side.
 *
 * This is the single point where LLM output is interpreted.
 * All downstream consumers (SSE, HTTP, MCP) receive AssistantResponse.
 */
export async function normalizeAssistantResponse(
  rawText: string,
  opts: NormalizeOptions,
): Promise<AssistantResponse> {
  const executeActions = opts.execute_actions !== false;
  const actionsTaken: AssistantAction[] = [];
  let reply = rawText;
  let schemaPatch: unknown = null;
  let createdWorkflow: AssistantResponse["created_workflow"] = null;
  const uiActions: UiAction[] = [];

  // Try to parse as JSON
  const parsed = tryParseJson(rawText);

  if (parsed) {
    // Extract clean reply text
    reply = extractReply(parsed, rawText);

    // Extract schema patch
    if (parsed.schema_patch && typeof parsed.schema_patch === "object") {
      schemaPatch = parsed.schema_patch;
    }

    // Extract UI actions (highlights, etc.)
    if (Array.isArray(parsed.actions)) {
      for (const act of parsed.actions) {
        if (act && typeof act === "object" && act.type === "highlight") {
          uiActions.push(act as UiAction);
        }
      }
    }

    // Execute workflow creation
    if (parsed.create_workflow && typeof parsed.create_workflow === "object" && executeActions) {
      const action = await executeWorkflowCreation(parsed.create_workflow, opts);
      actionsTaken.push(action);
      if (action.status === "executed" && action.result) {
        createdWorkflow = { id: action.result.id as string, name: action.result.name as string, ...action.result };
      } else if (action.status === "failed") {
        reply = reply + `\n\n⚠️ Ошибка создания процесса: ${action.error}`;
      }
    }
  }

  // If reply still looks like JSON, sanitize it
  reply = sanitizeReply(reply);

  return {
    reply,
    chat_id: opts.chat_id,
    schema_patch: schemaPatch,
    created_workflow: createdWorkflow,
    actions_taken: actionsTaken,
    ui_actions: uiActions,
  };
}

// ── Action Executors (#527: route through act-envelope spine) ─────────────────

async function executeWorkflowCreation(
  def: unknown,
  opts: NormalizeOptions,
): Promise<AssistantAction> {
  const params = def as Record<string, unknown>;
  const actionId = "workflow.create";

  const envelope: ActEnvelope = {
    action: actionId,
    category: classifyAction(actionId),
    args: {
      id: (params?.id as string) || `proc_${Date.now().toString(36)}`,
      name: (params?.name as string) || "Новый процесс",
      elements: Array.isArray(params?.elements) ? params.elements : [],
      flow: Array.isArray(params?.flow) ? params.flow : [],
      draft: true,
    },
    meta: {
      session_id: opts.session_id ?? "assistant",
      agent_chain: opts.agent_id ?? "tsunade",
    },
  };

  const result = await executeAction(envelope, { agentChain: opts.agent_id ?? "tsunade" });

  if (result.requires_confirm) {
    return {
      action: actionId,
      params: envelope.args,
      status: "needs_confirm",
      description: "Create draft workflow (requires confirmation)",
    };
  }

  if (!result.ok) {
    return {
      action: actionId,
      params: envelope.args,
      status: "failed",
      description: "Create draft workflow",
      error: result.error ?? "Unknown error",
    };
  }

  return {
    action: actionId,
    params: envelope.args,
    status: "executed",
    description: `Created draft workflow "${(result.data as any)?.name ?? envelope.args.name}"`,
    result: result.data as Record<string, unknown>,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function tryParseJson(raw: string): Record<string, unknown> | null {
  // Try direct parse
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object") return obj as Record<string, unknown>;
  } catch {}

  // Try stripping markdown fences
  const stripped = stripMarkdownFences(raw);
  if (stripped !== raw) {
    try {
      const obj = JSON.parse(stripped);
      if (obj && typeof obj === "object") return obj as Record<string, unknown>;
    } catch {}
  }

  return null;
}

function stripMarkdownFences(raw: string): string {
  const m = raw.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/);
  return m ? m[1].trim() : raw;
}

function extractReply(parsed: Record<string, unknown>, fallback: string): string {
  // Prefer explicit "reply" field, then "text", then "message"
  if (typeof parsed.reply === "string" && parsed.reply.trim()) return parsed.reply;
  if (typeof parsed.text === "string" && parsed.text.trim()) return parsed.text;
  if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message;
  // If JSON was parsed but no text field found, generate a summary
  if (parsed.create_workflow) {
    const name = (parsed.create_workflow as Record<string, unknown>)?.name;
    return `Процесс${name ? ` "${name}"` : ""} создан.`;
  }
  if (parsed.schema_patch) {
    return "Схема обновлена.";
  }
  return fallback;
}

function sanitizeReply(text: string): string {
  const trimmed = text.trim();
  // If the entire text is still JSON, something went wrong — extract what we can
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const obj = JSON.parse(trimmed);
      if (typeof obj.reply === "string") return obj.reply;
      if (typeof obj.text === "string") return obj.text;
      if (typeof obj.message === "string") return obj.message;
      // Last resort: show a generic message
      return "Выполнено.";
    } catch {
      // Not valid JSON after all — return as-is
    }
  }
  // Strip markdown code fences from reply
  if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
    const inner = trimmed.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
    // If the inner content is still JSON, don't show it
    if (inner.trim().startsWith("{")) return "Выполнено.";
    return inner.trim();
  }
  return text;
}

// ── SSE Helper ────────────────────────────────────────────────────────────────

/**
 * Build SSE `parsed` event payload from AssistantResponse.
 * Used by the streaming path in ai.ts.
 */
export function buildSseParsedEvent(resp: AssistantResponse): Record<string, unknown> {
  return {
    type: "parsed",
    reply: resp.reply,
    schema_patch: resp.schema_patch,
    created_workflow: resp.created_workflow,
    actions: resp.ui_actions,
    actions_taken: resp.actions_taken,
  };
}
