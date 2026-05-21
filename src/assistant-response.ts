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
import { listWorkItems } from "./runtime/work-items";
import {
  buildWorkflowObservableResult,
  type WorkflowActionReceipt as ActionReceipt,
  type WorkflowActionReceiptResource as ActionReceiptResource,
  type WorkflowAssistantAction as AssistantAction,
  type WorkflowObservableResult as ObservableResult,
  type WorkflowPendingConfirmation as PendingConfirmation,
} from "./workflow-action-contract";
import { createConfirmation } from "./confirmation-store";
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
  /** Current workflow visible in the editor; used to make schema_patch durable. */
  current_workflow_id?: string;
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
      if (executeActions) {
        const patchAction = await executeWorkflowPatchFromSchema(parsed.schema_patch, opts);
        if (patchAction) {
          actionsTaken.push(patchAction);
          if (patchAction.status === "executed") {
            actionReceipts.push(buildWorkflowPatchReceipt(patchAction, opts, "succeeded"));
            reply = reply + `\n\nИзменение процесса сохранено через workflow.patch.`;
          } else if (patchAction.status === "needs_confirm") {
            pendingConfirmations.push(await buildPendingConfirmation("workflow.patch", patchAction.params, opts));
            actionReceipts.push(buildWorkflowPatchReceipt(patchAction, opts, "pending_confirmation"));
            reply = reply + `\n\nТребуется подтверждение перед сохранением изменения процесса.`;
          } else if (patchAction.status === "failed") {
            actionReceipts.push(buildWorkflowPatchReceipt(patchAction, opts, "failed"));
            reply = reply + `\n\n⚠️ Изменение процесса не сохранено: ${patchAction.error}`;
          }
        }
      }
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
          const a = act as Record<string, unknown>;
          // Normalize: accept both `target` and `selector`, emit only `target`
          if (a.selector && !a.target) { a.target = a.selector; }
          delete a.selector;
          uiActions.push(a as unknown as UiAction);
        }
      }
    }

    // Execute workflow deletion (single)
    if (parsed.delete_workflow && typeof parsed.delete_workflow === "object" && executeActions) {
      const delDef = parsed.delete_workflow as Record<string, unknown>;
      const delAction = await executeWorkflowDeletion(delDef, opts);
      actionsTaken.push(delAction);
      if (delAction.status === "executed" && delAction.result) {
        actionReceipts.push(buildWorkflowDeleteReceipt(delAction, opts, "succeeded"));
        reply = reply + `\n\nПроцесс "${String(delAction.result.id)}" удалён.`;
      } else if (delAction.status === "needs_confirm") {
        pendingConfirmations.push(await buildPendingConfirmation("workflow.delete", delAction.params, opts));
        actionReceipts.push(buildWorkflowDeleteReceipt(delAction, opts, "pending_confirmation"));
        reply = reply + `\n\nТребуется подтверждение для удаления процесса.`;
      } else if (delAction.status === "failed") {
        actionReceipts.push(buildWorkflowDeleteReceipt(delAction, opts, "failed"));
        reply = reply + `\n\n⚠️ Ошибка удаления процесса: ${delAction.error}`;
      }
    }

    // Execute workflow batch deletion
    if (parsed.delete_workflows && typeof parsed.delete_workflows === "object" && executeActions) {
      const batchDef = parsed.delete_workflows as Record<string, unknown>;
      const batchAction = await executeWorkflowBatchDeletion(batchDef, opts);
      actionsTaken.push(batchAction);
      if (batchAction.status === "executed" && batchAction.result) {
        actionReceipts.push(buildWorkflowBatchDeleteReceipt(batchAction, opts, "succeeded"));
        reply = reply + `\n\n${batchAction.result.summary || 'Пакетное удаление выполнено.'}`;
      } else if (batchAction.status === "needs_confirm") {
        pendingConfirmations.push(await buildPendingConfirmation("workflow.batch_delete", batchAction.params, opts));
        actionReceipts.push(buildWorkflowBatchDeleteReceipt(batchAction, opts, "pending_confirmation"));
        reply = reply + `\n\nТребуется подтверждение для пакетного удаления процессов.`;
      } else if (batchAction.status === "failed") {
        actionReceipts.push(buildWorkflowBatchDeleteReceipt(batchAction, opts, "failed"));
        reply = reply + `\n\n⚠️ Ошибка пакетного удаления: ${batchAction.error}`;
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
        pendingConfirmations.push(await buildPendingConfirmation("workflow.create", action.params, opts));
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
        pendingConfirmations.push(await buildPendingConfirmation("case.start", action.params, opts));
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

async function executeWorkflowDeletion(
  def: unknown,
  opts: NormalizeOptions,
): Promise<AssistantAction> {
  const params = def as Record<string, unknown>;
  const id = String(params.id ?? "");
  if (!id) {
    return { action: "workflow.delete", params, status: "failed", description: "Delete workflow", error: "id required" };
  }

  try {
    const result = await executeAction({
      action: "workflow.delete",
      category: "act",
      args: { id },
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
        action: "workflow.delete",
        params: { id },
        status: "needs_confirm",
        description: "Delete workflow requires confirmation",
      };
    }

    if (!result.ok) {
      return {
        action: "workflow.delete",
        params: { id },
        status: "failed",
        description: "Delete workflow",
        error: result.error ?? "Unknown error",
      };
    }

    return {
      action: "workflow.delete",
      params: { id },
      status: "executed",
      description: `Archived workflow "${id}"`,
      result: { id, ...(result.data as Record<string, unknown> ?? {}) },
    };
  } catch (e: any) {
    return {
      action: "workflow.delete",
      params: { id },
      status: "failed",
      description: "Delete workflow",
      error: e.message,
    };
  }
}

async function executeWorkflowBatchDeletion(
  def: unknown,
  opts: NormalizeOptions,
): Promise<AssistantAction> {
  const params = def as Record<string, unknown>;
  const ids = Array.isArray(params.ids) ? params.ids.map(String) : [];

  if (ids.length === 0) {
    return { action: "workflow.batch_delete", params, status: "failed", description: "Batch delete workflows", error: "ids array required" };
  }

  try {
    const result = await executeAction({
      action: "workflow.batch_delete",
      category: "act",
      args: { ids },
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
        action: "workflow.batch_delete",
        params: { ids },
        status: "needs_confirm",
        description: "Batch delete workflows requires confirmation",
      };
    }

    const data = (result.data as Record<string, unknown>) ?? {};
    return {
      action: "workflow.batch_delete",
      params: { ids },
      status: "executed",
      description: `Batch deleted ${ids.length} workflow(s)`,
      result: {
        ids,
        deleted_count: data.deleted_count ?? 0,
        skipped_count: data.skipped_count ?? 0,
        total_deleted_cases: data.total_deleted_cases ?? 0,
        summary: data.summary ?? `Удалено процессов: ${data.deleted_count ?? 0}`,
      },
    };
  } catch (e: any) {
    return {
      action: "workflow.batch_delete",
      params: { ids },
      status: "failed",
      description: "Batch delete workflows",
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
        next_work_item: await findNextPendingWorkItem(data.case_id),
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

function schemaPatchTargetId(patch: Record<string, unknown>, opts: NormalizeOptions): string | null {
  const raw = typeof patch.id === "string"
    ? patch.id
    : typeof patch.workflow_id === "string"
    ? patch.workflow_id
    : typeof patch.process_id === "string"
    ? patch.process_id
    : opts.current_workflow_id;
  const id = raw?.trim();
  return id || null;
}

function toDurableWorkflowPatch(schemaPatch: Record<string, unknown>): Record<string, unknown> | null {
  const supportedKeys = [
    "set_name",
    "set_description",
    "add_elements",
    "update_elements",
    "remove_elements",
    "add_flow",
    "remove_flow",
    "set_triggers",
  ];
  const patch: Record<string, unknown> = {};
  for (const key of supportedKeys) {
    if (Object.prototype.hasOwnProperty.call(schemaPatch, key)) {
      patch[key] = schemaPatch[key];
    }
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

async function executeWorkflowPatchFromSchema(
  schemaPatch: unknown,
  opts: NormalizeOptions,
): Promise<AssistantAction | null> {
  if (!schemaPatch || typeof schemaPatch !== "object" || Array.isArray(schemaPatch)) return null;
  const rawPatch = schemaPatch as Record<string, unknown>;
  const workflowId = schemaPatchTargetId(rawPatch, opts);
  const patch = toDurableWorkflowPatch(rawPatch);

  if (!workflowId || !patch) {
    return {
      action: "workflow.patch",
      params: {
        ...(workflowId ? { id: workflowId } : {}),
        ...(patch ? { patch } : {}),
        preview_only: true,
      },
      status: "skipped",
      description: "Schema patch is preview-only because it has no durable workflow.patch target or supported server mutation",
    };
  }

  const actionArgs = {
    id: workflowId,
    patch,
    idempotency_key: `assistant:${opts.session_id ?? opts.chat_id}:workflow.patch:${randomUUID()}`,
  };
  const sessionId = opts.session_id ?? opts.chat_id;
  const agentChain = opts.agent_id ?? "tsunade";
  const autonomy = opts.autonomy_overrides?.["workflow.patch"]
    ?? opts.autonomy_overrides?.["workflow.update"]
    ?? await checkAutonomy("workflow.patch");

  if (autonomy === "disabled") {
    await auditLog({
      timestamp: new Date().toISOString(),
      session_id: sessionId,
      action_type: "workflow.patch",
      parameters: JSON.stringify(actionArgs),
      result: "blocked",
      agent_chain: agentChain,
    }).catch(() => {});
    return {
      action: "workflow.patch",
      params: actionArgs,
      status: "failed",
      description: "Apply workflow schema patch",
      error: "workflow.patch is disabled by assistant permissions",
    };
  }

  if (autonomy === "confirm") {
    await auditLog({
      timestamp: new Date().toISOString(),
      session_id: sessionId,
      action_type: "workflow.patch",
      parameters: JSON.stringify(actionArgs),
      result: "requires_confirm",
      agent_chain: agentChain,
    }).catch(() => {});
    return {
      action: "workflow.patch",
      params: actionArgs,
      status: "needs_confirm",
      description: "Apply workflow schema patch requires confirmation",
    };
  }

  try {
    const result = await executeAction({
      action: "workflow.patch",
      category: "act",
      args: actionArgs,
      meta: {
        session_id: sessionId,
        agent_chain: agentChain,
        idempotency_key: actionArgs.idempotency_key,
      },
    }, {
      skipAutonomy: true,
      session_id: sessionId,
      agent_chain: agentChain,
    });

    if (!result.ok || !result.data || typeof result.data !== "object") {
      return {
        action: "workflow.patch",
        params: actionArgs,
        status: "failed",
        description: "Apply workflow schema patch",
        error: result.error ?? "Unknown action execution error",
        ...(result.data && typeof result.data === "object" ? { result: result.data as Record<string, unknown> } : {}),
      };
    }

    return {
      action: "workflow.patch",
      params: actionArgs,
      status: "executed",
      description: `Applied workflow schema patch to "${workflowId}"`,
      result: result.data as Record<string, unknown>,
    };
  } catch (e: any) {
    return {
      action: "workflow.patch",
      params: actionArgs,
      status: "failed",
      description: "Apply workflow schema patch",
      error: e.message,
    };
  }
}

async function buildPendingConfirmation(
  action: string,
  params: Record<string, unknown>,
  opts: NormalizeOptions,
): Promise<PendingConfirmation> {
  const record = await createConfirmation({
    action,
    title: `Confirmation required: ${action}`,
    summary: `Assistant requested ${action} and this action is configured as confirm-required.`,
    params,
    chat_id: opts.chat_id,
    session_id: opts.session_id,
  });
  return {
    id: record.id,
    action,
    title: record.title,
    summary: record.summary,
    status: "required",
    permission: {
      actor_scope: "assistant_on_behalf_of_user",
      autonomy: "confirm",
      confirmation_required: true,
    },
    params: record.params,
    created_at: record.created_at,
    expires_at: record.expires_at,
    chat_id: record.chat_id,
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
  const nextWorkItem = action.result?.next_work_item && typeof action.result.next_work_item === "object"
    ? action.result.next_work_item as Record<string, unknown>
    : null;

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
  if (nextWorkItem && typeof nextWorkItem.work_item_id === "string") {
    changedResources.push({
      kind: "work_item",
      id: nextWorkItem.work_item_id,
      ...(typeof nextWorkItem.label === "string" ? { label: nextWorkItem.label } : {}),
      change: "pending",
    });
  }

  const nextTaskSummary = nextWorkItem && typeof nextWorkItem.label === "string"
    ? ` Следующая задача: ${nextWorkItem.label}${typeof nextWorkItem.assignee === "string" ? ` -> ${nextWorkItem.assignee}` : ""}.`
    : "";

  return {
    id: randomUUID(),
    action: "case.start",
    status,
    summary:
      status === "succeeded"
        ? `Запущен прогон${subject ? ` "${subject}"` : ""}.${nextTaskSummary}`
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

function buildWorkflowDeleteReceipt(
  action: AssistantAction,
  opts: NormalizeOptions,
  status: ActionReceipt["status"],
): ActionReceipt {
  const workflowId = typeof action.params.id === "string" ? action.params.id : "workflow.delete";
  return {
    id: randomUUID(),
    action: "workflow.delete",
    status,
    summary:
      status === "succeeded"
        ? `Процесс удалён.`
        : status === "pending_confirmation"
        ? `Удаление процесса ожидает подтверждения.`
        : `Удаление процесса завершилось ошибкой.`,
    ...(action.error ? { details: action.error } : {}),
    changed_resources: [
      {
        kind: "workflow",
        id: workflowId,
        change: status === "succeeded" ? "updated" : status === "pending_confirmation" ? "pending" : "failed",
      },
    ],
    audit: {
      session_id: opts.session_id ?? opts.chat_id,
      action_type: "workflow.delete",
    },
  };
}

function buildWorkflowBatchDeleteReceipt(
  action: AssistantAction,
  opts: NormalizeOptions,
  status: ActionReceipt["status"],
): ActionReceipt {
  const ids = Array.isArray(action.params.ids) ? action.params.ids as string[] : [];
  const deletedCount = typeof action.result?.deleted_count === "number" ? action.result.deleted_count : 0;
  const skippedCount = typeof action.result?.skipped_count === "number" ? action.result.skipped_count : 0;
  return {
    id: randomUUID(),
    action: "workflow.batch_delete",
    status,
    summary:
      status === "succeeded"
        ? `Пакетное удаление: ${deletedCount} удалено, ${skippedCount} пропущено.`
        : status === "pending_confirmation"
        ? `Пакетное удаление ${ids.length} процессов ожидает подтверждения.`
        : `Пакетное удаление завершилось ошибкой.`,
    ...(action.error ? { details: action.error } : {}),
    changed_resources: ids.map(id => ({
      kind: "workflow" as const,
      id,
      change: status === "succeeded" ? "updated" as const : status === "pending_confirmation" ? "pending" as const : "failed" as const,
    })),
    audit: {
      session_id: opts.session_id ?? opts.chat_id,
      action_type: "workflow.batch_delete",
    },
  };
}

async function findNextPendingWorkItem(caseId: unknown): Promise<Record<string, unknown> | null> {
  if (typeof caseId !== "string" || !caseId) return null;
  const { items } = await listWorkItems({ case_id: caseId, status: "pending", limit: 1 });
  const next = items[0] ?? null;
  if (!next) return null;
  return {
    work_item_id: next.work_item_id,
    label: next.label,
    assignee: next.assignee,
    status: next.status,
    element_id: next.element_id,
    process_id: next.process_id,
    case_id: next.case_id,
  };
}

function buildWorkflowPatchReceipt(
  action: AssistantAction,
  opts: NormalizeOptions,
  status: ActionReceipt["status"],
): ActionReceipt {
  const result = action.result && typeof action.result === "object" ? action.result : {};
  const workflowId = typeof result.workflow_id === "string"
    ? result.workflow_id
    : typeof action.params.id === "string"
    ? action.params.id
    : "workflow.patch";
  const rawChanges = Array.isArray(result.changed_resources)
    ? result.changed_resources as Record<string, unknown>[]
    : [];
  const changedResources: ActionReceiptResource[] = rawChanges
    .map(change => {
      const rawKind = typeof change.kind === "string" ? change.kind : "workflow";
      const kind = rawKind === "flow" ? "flow" : rawKind === "workflow" ? "workflow" : "element";
      const rawChange = typeof change.change === "string" ? change.change : "updated";
      const mappedChange =
        status === "pending_confirmation"
          ? "pending"
          : status === "failed"
          ? "failed"
          : rawChange === "created"
          ? "created"
          : "updated";
      return {
        kind,
        id: typeof change.id === "string" ? change.id : workflowId,
        change: mappedChange,
      };
    });
  if (changedResources.length === 0) {
    changedResources.push({
      kind: "workflow",
      id: workflowId,
      change: status === "succeeded" ? "updated" : status === "pending_confirmation" ? "pending" : "failed",
    });
  }

  return {
    id: randomUUID(),
    action: "workflow.patch",
    status,
    summary:
      status === "succeeded"
        ? `Изменение процесса сохранено: ${changedResources.length} объект(ов) затронуто.`
        : status === "pending_confirmation"
        ? `Изменение процесса ожидает подтверждения.`
        : `Изменение процесса отклонено серверной проверкой.`,
    ...(action.error ? { details: action.error } : {}),
    changed_resources: changedResources,
    audit: {
      session_id: opts.session_id ?? opts.chat_id,
      action_type: "workflow.patch",
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
  if (parsed.delete_workflow) {
    const id = (parsed.delete_workflow as Record<string, unknown>)?.id;
    return `Запрашиваю подтверждение на удаление процесса${id ? ` "${id}"` : ""}.`;
  }
  if (parsed.delete_workflows) {
    const ids = (parsed.delete_workflows as Record<string, unknown>)?.ids;
    const count = Array.isArray(ids) ? ids.length : 0;
    return `Запрашиваю подтверждение на удаление ${count} процессов.`;
  }
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
