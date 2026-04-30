/**
 * assistant-response.ts — Canonical server-side response normalization (#528)
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

import { executeAction } from "./act-envelope";
import { auditLog, checkAutonomy } from "./assistant-actions";
import type { AutonomyLevel } from "./assistant-actions";
import {
  buildWorkflowObservableResult,
  type WorkflowActionReceipt as ActionReceipt,
  type WorkflowActionReceiptResource as ActionReceiptResource,
  type WorkflowAssistantAction as AssistantAction,
  type WorkflowObservableResult as ObservableResult,
  type WorkflowPendingConfirmation as PendingConfirmation,
} from "./workflow-action-contract";
import { randomUUID } from "crypto";

// ── Types ─────────────────────────────────────────────────────────────────────

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
  /** Explicit confirmations required before risky assistant actions may proceed */
  pending_confirmations: PendingConfirmation[];
  /** Canonical post-action receipts for observable operator results */
  action_receipts: ActionReceipt[];
  /** Aggregate observable result surface for the whole assistant turn */
  observable_result: ObservableResult;
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
  /** Deterministic autonomy overrides used by operator eval harnesses and tests */
  autonomy_overrides?: Partial<Record<string, AutonomyLevel>>;
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
  const pendingConfirmations: PendingConfirmation[] = [];
  const actionReceipts: ActionReceipt[] = [];
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
      const schemaPatchReceipt = await buildSchemaPatchReceipt(parsed.schema_patch, opts);
      actionReceipts.push(schemaPatchReceipt);
    }

    const openWorkflow = extractOpenWorkflow(parsed.open_workflow);
    if (openWorkflow) {
      const action = buildWorkflowOpenAction(openWorkflow);
      await auditLog({
        timestamp: new Date().toISOString(),
        session_id: opts.session_id ?? opts.chat_id,
        action_type: "workflow.open",
        parameters: JSON.stringify(openWorkflow),
        result: "ok",
        agent_chain: opts.agent_id ?? "tsunade",
      }).catch(() => {});
      actionsTaken.push(action);
      actionReceipts.push(buildWorkflowOpenReceipt(action, opts));
      uiActions.push({
        type: "navigate",
        target: `/editor/${openWorkflow.id}`,
        path: `/editor/${openWorkflow.id}`,
        workflow_id: openWorkflow.id,
        ...(openWorkflow.name ? { message: `Открыть процесс "${openWorkflow.name}"` } : {}),
      });
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
        actionReceipts.push(buildWorkflowCreateReceipt(action, opts, "succeeded"));
      } else if (action.status === "needs_confirm") {
        pendingConfirmations.push(buildPendingConfirmation("workflow.create", action.params));
        actionReceipts.push(buildWorkflowCreateReceipt(action, opts, "pending_confirmation"));
        reply = reply + `\n\nТребуется подтверждение перед выполнением действия: workflow.create.`;
      } else if (action.status === "failed") {
        actionReceipts.push(buildWorkflowCreateReceipt(action, opts, "failed"));
        reply = reply + `\n\n⚠️ Ошибка создания процесса: ${action.error}`;
      }
    }

    const caseStart = extractCaseStart(parsed.start_case ?? parsed.case_start ?? parsed["case.start"]);
    if (caseStart && executeActions) {
      const action = await executeCaseStart(caseStart, opts);
      actionsTaken.push(action);
      if (action.status === "executed") {
        actionReceipts.push(buildCaseStartReceipt(action, opts, "succeeded"));
        const caseId = typeof action.result?.case_id === "string" ? action.result.case_id : undefined;
        const processId = typeof action.result?.process_id === "string"
          ? action.result.process_id
          : typeof action.params.process_id === "string"
          ? action.params.process_id
          : undefined;
        uiActions.push({
          type: "navigate",
          target: caseId ? `/monitor?case_id=${caseId}` : "/monitor",
          path: caseId ? `/monitor?case_id=${caseId}` : "/monitor",
          ...(caseId ? { case_id: caseId } : {}),
          ...(processId ? { workflow_id: processId, process_id: processId } : {}),
          message: "Открыть мониторинг прогона",
        });
      } else if (action.status === "needs_confirm") {
        pendingConfirmations.push(buildPendingConfirmation("case.start", action.params));
        actionReceipts.push(buildCaseStartReceipt(action, opts, "pending_confirmation"));
        reply = reply + `\n\nТребуется подтверждение перед выполнением действия: case.start.`;
      } else if (action.status === "failed") {
        actionReceipts.push(buildCaseStartReceipt(action, opts, "failed"));
        reply = reply + `\n\n⚠️ Ошибка запуска процесса: ${action.error}`;
      }
    }
  }

  // If reply still looks like JSON, sanitize it
  reply = sanitizeReply(reply);
  const observableResult = buildWorkflowObservableResult(actionReceipts);

  return {
    reply,
    chat_id: opts.chat_id,
    schema_patch: schemaPatch,
    created_workflow: createdWorkflow,
    actions_taken: actionsTaken,
    pending_confirmations: pendingConfirmations,
    action_receipts: actionReceipts,
    observable_result: observableResult,
    ui_actions: uiActions,
  };
}

// ── Action Executors ──────────────────────────────────────────────────────────

async function executeWorkflowCreation(
  def: unknown,
  opts: NormalizeOptions,
): Promise<AssistantAction> {
  const params = def as Record<string, unknown>;
  const sessionId = opts.session_id ?? "assistant";
  const agentChain = opts.agent_id ?? "tsunade";
  const autonomy = opts.autonomy_overrides?.["workflow.create"] ?? await checkAutonomy("workflow.create");

  if (autonomy === "disabled") {
    await auditLog({
      timestamp: new Date().toISOString(),
      session_id: sessionId,
      action_type: "workflow.create",
      parameters: JSON.stringify(params),
      result: "blocked",
      agent_chain: agentChain,
    }).catch(() => {});
    return {
      action: "workflow.create",
      params,
      status: "failed",
      description: "Create draft workflow",
      error: "workflow.create is disabled by assistant permissions",
    };
  }

  if (autonomy === "confirm") {
    await auditLog({
      timestamp: new Date().toISOString(),
      session_id: sessionId,
      action_type: "workflow.create",
      parameters: JSON.stringify(params),
      result: "requires_confirm",
      agent_chain: agentChain,
    }).catch(() => {});
    return {
      action: "workflow.create",
      params,
      status: "needs_confirm",
      description: "Create draft workflow requires confirmation",
    };
  }

  try {
    const actionArgs = {
      ...(typeof params === "object" ? params : {}),
      id: (params?.id as string) || `proc_${Date.now().toString(36)}`,
      version: typeof params?.version === "string" ? params.version : "1.0",
      name: (params?.name as string) || "Новый процесс",
      elements: Array.isArray(params?.elements) ? params.elements : [],
      flow: Array.isArray(params?.flow) ? params.flow : [],
      draft: true,
    };
    const result = await executeAction({
      action: "workflow.create",
      category: "act",
      args: actionArgs,
      meta: {
        session_id: opts.session_id ?? opts.chat_id,
        agent_chain: opts.agent_id ?? "tsunade",
      },
    }, {
      skipAutonomy: true,
      session_id: opts.session_id ?? opts.chat_id,
      agent_chain: opts.agent_id ?? "tsunade",
    });

    if (result.requires_confirm) {
      return {
        action: "workflow.create",
        params: actionArgs,
        status: "needs_confirm",
        description: "Create draft workflow requires confirmation",
      };
    }

    if (!result.ok || !result.data || typeof result.data !== "object") {
      return {
        action: "workflow.create",
        params: actionArgs,
        status: "failed",
        description: "Create draft workflow",
        error: result.error ?? "Unknown action execution error",
      };
    }
    const data = result.data as Record<string, unknown>;

    return {
      action: "workflow.create",
      params: actionArgs,
      status: "executed",
      description: `Created draft workflow "${String(data.name ?? "Новый процесс")}"`,
      result: {
        id: data.id as string,
        name: data.name as string,
        status: (data.status as string | undefined) ?? "draft",
      },
    };
  } catch (e: any) {
    return {
      action: "workflow.create",
      params: params as Record<string, unknown>,
      status: "failed",
      description: "Create draft workflow",
      error: e.message,
    };
  }
}

async function executeCaseStart(
  params: Record<string, unknown>,
  opts: NormalizeOptions,
): Promise<AssistantAction> {
  const processId = String(params.process_id);
  const actionArgs = {
    process_id: processId,
    subject: typeof params.subject === "string" && params.subject.trim()
      ? params.subject.trim()
      : `Запуск процесса ${processId}`,
    payload: params.payload && typeof params.payload === "object" ? params.payload : {},
    ...(typeof params.start_node === "string" && params.start_node.trim() ? { start_node: params.start_node.trim() } : {}),
  };

  try {
    const result = await executeAction({
      action: "case.start",
      category: "act",
      args: actionArgs,
      meta: {
        session_id: opts.session_id ?? opts.chat_id,
        agent_chain: opts.agent_id ?? "tsunade",
      },
    }, {
      session_id: opts.session_id ?? opts.chat_id,
      agent_chain: opts.agent_id ?? "tsunade",
    });

    if (result.requires_confirm) {
      return {
        action: "case.start",
        params: actionArgs,
        status: "needs_confirm",
        description: "Start workflow case requires confirmation",
      };
    }

    if (!result.ok || !result.data || typeof result.data !== "object") {
      return {
        action: "case.start",
        params: actionArgs,
        status: "failed",
        description: "Start workflow case",
        error: result.error ?? "Unknown action execution error",
      };
    }
    const data = result.data as Record<string, unknown>;
    return {
      action: "case.start",
      params: actionArgs,
      status: "executed",
      description: `Started workflow case "${String(data.subject ?? actionArgs.subject)}"`,
      result: {
        case_id: data.case_id as string,
        process_id: data.process_id as string,
        subject: data.subject as string,
        status: data.status as string,
        position: data.position as string,
      },
    };
  } catch (e: any) {
    return {
      action: "case.start",
      params: actionArgs,
      status: "failed",
      description: "Start workflow case",
      error: e.message,
    };
  }
}

function buildPendingConfirmation(action: string, params: Record<string, unknown>): PendingConfirmation {
  return {
    id: randomUUID(),
    action,
    title: `Confirmation required: ${action}`,
    summary: `Assistant requested ${action} and this action is configured as confirm-required.`,
    status: "required",
    permission: {
      actor_scope: "assistant_on_behalf_of_user",
      autonomy: "confirm",
      confirmation_required: true,
    },
    params,
  };
}

function buildWorkflowCreateReceipt(
  action: AssistantAction,
  opts: NormalizeOptions,
  status: ActionReceipt["status"],
): ActionReceipt {
  const workflowId = typeof action.result?.id === "string"
    ? action.result.id
    : typeof action.params.id === "string"
    ? action.params.id
    : "workflow.create";
  const workflowName = typeof action.result?.name === "string"
    ? action.result.name
    : typeof action.params.name === "string"
    ? action.params.name
    : undefined;
  return {
    id: randomUUID(),
    action: "workflow.create",
    status,
    summary:
      status === "succeeded"
        ? `Создан черновик процесса${workflowName ? ` "${workflowName}"` : ""}.`
        : status === "pending_confirmation"
        ? `Создание процесса${workflowName ? ` "${workflowName}"` : ""} ожидает подтверждения.`
        : `Создание процесса${workflowName ? ` "${workflowName}"` : ""} завершилось ошибкой.`,
    ...(action.error ? { details: action.error } : {}),
    changed_resources: [
      {
        kind: "workflow",
        id: workflowId,
        ...(workflowName ? { label: workflowName } : {}),
        change: status === "succeeded" ? "created" : status === "pending_confirmation" ? "pending" : "failed",
      },
    ],
    audit: {
      session_id: opts.session_id ?? opts.chat_id,
      action_type: "workflow.create",
    },
  };
}

function buildCaseStartReceipt(
  action: AssistantAction,
  opts: NormalizeOptions,
  status: ActionReceipt["status"],
): ActionReceipt {
  const caseId = typeof action.result?.case_id === "string" ? action.result.case_id : "case.start";
  const subject = typeof action.result?.subject === "string"
    ? action.result.subject
    : typeof action.params.subject === "string"
    ? action.params.subject
    : undefined;
  const processId = typeof action.result?.process_id === "string"
    ? action.result.process_id
    : typeof action.params.process_id === "string"
    ? action.params.process_id
    : undefined;

  const changedResources: ActionReceiptResource[] = [
    {
      kind: "case",
      id: caseId,
      ...(subject ? { label: subject } : {}),
      change: status === "succeeded" ? "started" : status === "pending_confirmation" ? "pending" : "failed",
    },
  ];
  if (processId) {
    changedResources.push({
      kind: "workflow",
      id: processId,
      change: "opened",
    });
  }

  return {
    id: randomUUID(),
    action: "case.start",
    status,
    summary:
      status === "succeeded"
        ? `Запущен прогон${subject ? ` "${subject}"` : ""}.`
        : status === "pending_confirmation"
        ? `Запуск процесса${subject ? ` "${subject}"` : ""} ожидает подтверждения.`
        : `Запуск процесса${subject ? ` "${subject}"` : ""} завершился ошибкой.`,
    ...(action.error ? { details: action.error } : {}),
    changed_resources: changedResources,
    audit: {
      session_id: opts.session_id ?? opts.chat_id,
      action_type: "case.start",
    },
  };
}

async function buildSchemaPatchReceipt(
  schemaPatch: unknown,
  opts: NormalizeOptions,
): Promise<ActionReceipt> {
  const patch = schemaPatch as Record<string, unknown>;
  const changedResources: ActionReceiptResource[] = [];

  if (Array.isArray(patch.update_elements)) {
    for (const item of patch.update_elements) {
      if (item && typeof item === "object" && typeof (item as Record<string, unknown>).id === "string") {
        changedResources.push({
          kind: "element",
          id: (item as Record<string, unknown>).id as string,
          change: "updated",
        });
      }
    }
  }
  if (patch.update_positions && typeof patch.update_positions === "object") {
    for (const id of Object.keys(patch.update_positions as Record<string, unknown>)) {
      changedResources.push({ kind: "element", id, change: "updated" });
    }
  }
  if (Array.isArray(patch.add_elements)) {
    for (const item of patch.add_elements) {
      if (item && typeof item === "object") {
        const id = typeof (item as Record<string, unknown>).id === "string"
          ? (item as Record<string, unknown>).id as string
          : `new-element-${changedResources.length + 1}`;
        changedResources.push({
          kind: "element",
          id,
          ...(typeof (item as Record<string, unknown>).label === "string" ? { label: (item as Record<string, unknown>).label as string } : {}),
          change: "created",
        });
      }
    }
  }
  if (Array.isArray(patch.remove_elements)) {
    for (const id of patch.remove_elements) {
      if (typeof id === "string") {
        changedResources.push({ kind: "element", id, change: "updated" });
      }
    }
  }
  if (Array.isArray(patch.add_flow)) {
    for (const edge of patch.add_flow) {
      if (Array.isArray(edge) && typeof edge[0] === "string" && typeof edge[1] === "string") {
        changedResources.push({ kind: "flow", id: `${edge[0]}:${edge[1]}`, change: "created" });
      }
    }
  }
  if (Array.isArray(patch.remove_flow)) {
    for (const edge of patch.remove_flow) {
      if (Array.isArray(edge) && typeof edge[0] === "string" && typeof edge[1] === "string") {
        changedResources.push({ kind: "flow", id: `${edge[0]}:${edge[1]}`, change: "updated" });
      }
    }
  }

  await auditLog({
    timestamp: new Date().toISOString(),
    session_id: opts.session_id ?? opts.chat_id,
    action_type: "workflow.update",
    parameters: JSON.stringify(schemaPatch),
    result: "ok",
    agent_chain: opts.agent_id ?? "tsunade",
  }).catch(() => {});

  return {
    id: randomUUID(),
    action: "workflow.update",
    status: "succeeded",
    summary: `Подготовлено изменение схемы: ${changedResources.length} объект(ов) затронуто.`,
    changed_resources: changedResources,
    audit: {
      session_id: opts.session_id ?? opts.chat_id,
      action_type: "workflow.update",
    },
  };
}

function extractOpenWorkflow(raw: unknown): { id: string; name?: string } | null {
  if (typeof raw === "string" && raw.trim()) return { id: raw.trim() };
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === "string"
    ? obj.id
    : typeof obj.workflow_id === "string"
    ? obj.workflow_id
    : null;
  if (!id) return null;
  return {
    id,
    ...(typeof obj.name === "string" ? { name: obj.name } : {}),
  };
}

function extractCaseStart(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const processId = typeof obj.process_id === "string"
    ? obj.process_id
    : typeof obj.workflow_id === "string"
    ? obj.workflow_id
    : typeof obj.id === "string"
    ? obj.id
    : null;
  if (!processId?.trim()) return null;
  return {
    process_id: processId.trim(),
    ...(typeof obj.subject === "string" ? { subject: obj.subject } : {}),
    ...(obj.payload && typeof obj.payload === "object" ? { payload: obj.payload } : {}),
    ...(typeof obj.start_node === "string" ? { start_node: obj.start_node } : {}),
  };
}

function buildWorkflowOpenAction(workflow: { id: string; name?: string }): AssistantAction {
  return {
    action: "workflow.open",
    params: workflow,
    status: "executed",
    description: "Open workflow in editor",
    result: {
      id: workflow.id,
      path: `/editor/${workflow.id}`,
      ...(workflow.name ? { name: workflow.name } : {}),
    },
  };
}

function buildWorkflowOpenReceipt(action: AssistantAction, opts: NormalizeOptions): ActionReceipt {
  const workflowId = typeof action.result?.id === "string"
    ? action.result.id
    : typeof action.params.id === "string"
    ? action.params.id
    : "workflow.open";
  const workflowName = typeof action.result?.name === "string"
    ? action.result.name
    : typeof action.params.name === "string"
    ? action.params.name
    : undefined;

  return {
    id: randomUUID(),
    action: "workflow.open",
    status: "succeeded",
    summary: `Открыт процесс${workflowName ? ` "${workflowName}"` : ""}.`,
    changed_resources: [
      {
        kind: "workflow",
        id: workflowId,
        ...(workflowName ? { label: workflowName } : {}),
        change: "opened",
      },
    ],
    audit: {
      session_id: opts.session_id ?? opts.chat_id,
      action_type: "workflow.open",
    },
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
  if (parsed.start_case || parsed.case_start || parsed["case.start"]) {
    return "Запускаю процесс.";
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
    pending_confirmations: resp.pending_confirmations,
    action_receipts: resp.action_receipts,
    observable_result: resp.observable_result,
  };
}
