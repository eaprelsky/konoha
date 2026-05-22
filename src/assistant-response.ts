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
import { classifyAction, validateActionArgs } from "./action-registry";
import type { ActionCategory } from "./action-registry";
import { listWorkItems } from "./runtime/work-items";
import { listRoles } from "./runtime/roles";
import { getWorkflow } from "./workflow-loader";
import { buildWorkflowValidationReceipt } from "./workflow-validation-service";
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
  /** Explicit edit durability state for schema_patch turns. */
  edit_result: AssistantEditResult | null;
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

export type AssistantEditMode = "preview" | "pending_confirmation" | "committed" | "failed";

export interface AssistantEditResult {
  kind: "schema_patch";
  mode: AssistantEditMode;
  durable: boolean;
  action: "workflow.patch";
  summary: string;
  workflow_id?: string;
  receipt_id?: string;
  error?: string;
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

interface AssistantActionSequenceStep {
  action: string;
  args: Record<string, unknown>;
  category?: ActionCategory;
  meta?: {
    session_id?: string;
    agent_chain?: string;
    idempotency_key?: string;
  };
  halt_on_error?: boolean;
}

const ASSISTANT_ACTION_SEQUENCE_ALLOWLIST = new Set([
  "role.create",
  "workflow.create",
  "workflow.validate",
  "workflow.deploy",
  "case.start",
]);

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
  let editResult: AssistantEditResult | null = null;
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
            const partial = patchAction.result?.assistant_partial_failure === true;
            const receipt = buildWorkflowPatchReceipt(patchAction, opts, partial ? "partial" : "succeeded");
            actionReceipts.push(receipt);
            editResult = buildAssistantEditResult(patchAction, partial ? "failed" : "committed", receipt);
            reply = reply + (partial
              ? `\n\n⚠️ Изменение процесса сохранено частично: часть schema_patch не поддерживается durable workflow.patch.`
              : `\n\nИзменение процесса сохранено через workflow.patch.`);
          } else if (patchAction.status === "needs_confirm") {
            pendingConfirmations.push(await buildPendingConfirmation("workflow.patch", patchAction.params, opts));
            const receipt = buildWorkflowPatchReceipt(patchAction, opts, "pending_confirmation");
            actionReceipts.push(receipt);
            editResult = buildAssistantEditResult(patchAction, "pending_confirmation", receipt);
            reply = reply + `\n\nТребуется подтверждение перед сохранением изменения процесса.`;
          } else if (patchAction.status === "failed") {
            const receipt = buildWorkflowPatchReceipt(patchAction, opts, "failed");
            actionReceipts.push(receipt);
            editResult = buildAssistantEditResult(patchAction, "failed", receipt);
            reply = reply + `\n\n⚠️ Изменение процесса не сохранено: ${patchAction.error}`;
          } else if (patchAction.status === "skipped") {
            editResult = buildAssistantEditResult(patchAction, "preview");
          }
        }
      } else {
        editResult = {
          kind: "schema_patch",
          mode: "preview",
          durable: false,
          action: "workflow.patch",
          summary: "Schema patch is preview-only because action execution is disabled.",
        };
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

    const actionSequence = extractActionSequence(parsed);
    if (actionSequence.length > 0 && executeActions) {
      let haltedByFailure = false;
      for (const step of actionSequence) {
        if (haltedByFailure) {
          actionsTaken.push({
            action: step.action,
            params: step.args,
            status: "skipped",
            description: `Skipped ${step.action} because a previous assistant action failed`,
          });
          continue;
        }

        const action = await executeActionSequenceStep(step, opts);
        actionsTaken.push(action);

        if (action.status === "executed") {
          if (action.action === "workflow.create" && action.result) {
            createdWorkflow = { id: action.result.id as string, name: action.result.name as string, ...action.result };
            actionReceipts.push(buildWorkflowCreateReceipt(action, opts, "succeeded"));
          } else if (action.action === "case.start") {
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
          } else {
            actionReceipts.push(buildActionSequenceReceipt(action, opts, "succeeded"));
          }
        } else if (action.status === "needs_confirm") {
          pendingConfirmations.push(await buildPendingConfirmation(action.action, action.params, opts));
          actionReceipts.push(buildActionSequenceReceipt(action, opts, "pending_confirmation"));
          reply = reply + `\n\nТребуется подтверждение перед выполнением действия: ${action.action}.`;
        } else if (action.status === "failed") {
          actionReceipts.push(buildActionSequenceReceipt(action, opts, "failed"));
          reply = reply + `\n\n⚠️ Ошибка действия ${action.action}: ${action.error}`;
          if (step.halt_on_error !== false) haltedByFailure = true;
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

    const roleAssignments = extractRoleAssignmentSuggestions(parsed);
    if (roleAssignments.length > 0 && executeActions) {
      for (const suggestion of roleAssignments) {
        const action = await prepareRoleAssignmentSuggestion(suggestion, opts);
        actionsTaken.push(action);
        if (action.status === "needs_confirm") {
          pendingConfirmations.push(await buildPendingConfirmation(action.action, action.params, opts));
          actionReceipts.push(buildRoleAssignmentReceipt(action, opts, "pending_confirmation"));
        } else if (action.status === "failed") {
          actionReceipts.push(buildRoleAssignmentReceipt(action, opts, "failed"));
        }
      }
      if (roleAssignments.length === 1) {
        const action = actionsTaken[actionsTaken.length - 1];
        reply = reply + (action.status === "needs_confirm"
          ? `\n\nПредложение назначения роли ожидает подтверждения оператора.`
          : `\n\n⚠️ Предложение назначения роли отклонено: ${action.error}`);
      } else {
        const pending = actionReceipts.filter(receipt => receipt.action === "role.create" || receipt.action === "role.update")
          .filter(receipt => receipt.status === "pending_confirmation").length;
        const failed = actionReceipts.filter(receipt => receipt.action === "role.create" || receipt.action === "role.update")
          .filter(receipt => receipt.status === "failed").length;
        reply = reply + `\n\nПредложения назначения ролей: ${pending} ожидает подтверждения, ${failed} отклонено.`;
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
    edit_result: editResult,
    created_workflow: createdWorkflow,
    actions_taken: actionsTaken,
    pending_confirmations: pendingConfirmations,
    action_receipts: actionReceipts,
    observable_result: observableResult,
    ui_actions: uiActions,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function extractActionSequence(parsed: Record<string, unknown>): AssistantActionSequenceStep[] {
  const rawSequence =
    Array.isArray(parsed.action_sequence) ? parsed.action_sequence
    : Array.isArray(parsed.action_spine) ? parsed.action_spine
    : Array.isArray(parsed.assistant_actions) ? parsed.assistant_actions
    : Array.isArray(parsed.actions) ? parsed.actions.filter(item => isRecord(item) && typeof item.action === "string")
    : [];

  return rawSequence
    .filter(isRecord)
    .map((item): AssistantActionSequenceStep | null => {
      const action = typeof item.action === "string" && item.action.trim()
        ? item.action.trim()
        : typeof item.type === "string" && item.type.includes(".")
        ? item.type.trim()
        : "";
      if (!action) return null;
      const args = isRecord(item.args) ? item.args : {};
      const category = item.category === "act" || item.category === "inspect" || item.category === "drill"
        ? item.category
        : classifyAction(action);
      const meta = isRecord(item.meta)
        ? {
          ...(typeof item.meta.session_id === "string" ? { session_id: item.meta.session_id } : {}),
          ...(typeof item.meta.agent_chain === "string" ? { agent_chain: item.meta.agent_chain } : {}),
          ...(typeof item.meta.idempotency_key === "string" ? { idempotency_key: item.meta.idempotency_key } : {}),
        }
        : undefined;
      return {
        action,
        args,
        category,
        ...(meta ? { meta } : {}),
        ...(typeof item.halt_on_error === "boolean" ? { halt_on_error: item.halt_on_error } : {}),
      };
    })
    .filter((item): item is AssistantActionSequenceStep => Boolean(item));
}

async function executeActionSequenceStep(
  step: AssistantActionSequenceStep,
  opts: NormalizeOptions,
): Promise<AssistantAction> {
  if (!ASSISTANT_ACTION_SEQUENCE_ALLOWLIST.has(step.action)) {
    return {
      action: step.action,
      params: step.args,
      status: "failed",
      description: `Execute ${step.action}`,
      error: `${step.action} is not supported by assistant action_sequence`,
    };
  }

  const sessionId = opts.session_id ?? opts.chat_id;
  const agentChain = opts.agent_id ?? "tsunade";
  const result = await executeAction({
    action: step.action,
    category: step.category ?? classifyAction(step.action),
    args: step.args,
    meta: {
      session_id: sessionId,
      agent_chain: agentChain,
      ...step.meta,
    },
  }, {
    session_id: sessionId,
    agent_chain: agentChain,
  });

  if (result.requires_confirm) {
    return {
      action: step.action,
      params: step.args,
      status: "needs_confirm",
      description: `${step.action} requires confirmation`,
    };
  }

  if (!result.ok) {
    return {
      action: step.action,
      params: step.args,
      status: "failed",
      description: `Execute ${step.action}`,
      error: result.error ?? "Unknown action execution error",
      ...(isRecord(result.data) ? { result: result.data } : {}),
    };
  }

  const data = isRecord(result.data) ? result.data : { value: result.data };
  const actionResult = step.action === "case.start"
    ? {
      ...data,
      next_work_item: await findNextPendingWorkItem(data.case_id),
    }
    : data;

  return {
    action: step.action,
    params: step.args,
    status: "executed",
    description: `Executed ${step.action}`,
    result: actionResult,
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

interface RoleAssignmentSuggestion {
  workflow_id?: string;
  role?: string;
  assignee?: string;
  assignees?: string[];
  strategy?: string;
  manual_queue?: boolean;
  element_id?: string;
}

const ROLE_ASSIGNMENT_VALIDATION_CODES = new Set([
  "ROLE_UNRESOLVABLE",
  "ROLE_MISSING_ASSIGNEE",
  "ROLE_ASSIGNEE_UNRESOLVABLE",
]);

function extractRoleAssignmentSuggestions(parsed: Record<string, unknown>): RoleAssignmentSuggestion[] {
  const raw = parsed.role_assignment_suggestions ?? parsed.role_assignments ?? parsed.role_assignment ?? parsed["role.assign"];
  const values = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
  return values
    .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value))
    .map(value => {
      const workflowId = typeof value.workflow_id === "string"
        ? value.workflow_id
        : typeof value.process_id === "string"
        ? value.process_id
        : typeof value.id === "string"
        ? value.id
        : undefined;
      const assignees = Array.isArray(value.assignees)
        ? value.assignees.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map(item => item.trim())
        : undefined;
      return {
        ...(workflowId ? { workflow_id: workflowId.trim() } : {}),
        ...(typeof value.role === "string" ? { role: value.role.trim() } : {}),
        ...(typeof value.role_id === "string" && !value.role ? { role: value.role_id.trim() } : {}),
        ...(typeof value.assignee === "string" ? { assignee: value.assignee.trim() } : {}),
        ...(assignees ? { assignees } : {}),
        ...(typeof value.strategy === "string" ? { strategy: value.strategy.trim() } : {}),
        ...(value.manual_queue === true || value.mode === "manual" ? { manual_queue: true } : {}),
        ...(typeof value.element_id === "string" ? { element_id: value.element_id.trim() } : {}),
      };
    });
}

function normalizeAssignmentStrategy(value: unknown, fallback = "round-robin"): "round-robin" | "load-balancing" | "broadcast" | "manual" {
  if (value === "round-robin" || value === "load-balancing" || value === "broadcast" || value === "manual") return value;
  return fallback as "round-robin";
}

async function prepareRoleAssignmentSuggestion(
  suggestion: RoleAssignmentSuggestion,
  opts: NormalizeOptions,
): Promise<AssistantAction> {
  const workflowId = (suggestion.workflow_id ?? opts.current_workflow_id ?? "").trim();
  const role = suggestion.role?.trim() ?? "";
  const baseParams = {
    ...(workflowId ? { workflow_id: workflowId } : {}),
    ...(role ? { role } : {}),
    ...(suggestion.element_id ? { element_id: suggestion.element_id } : {}),
  };
  if (!workflowId) {
    return {
      action: "role.update",
      params: baseParams,
      status: "failed",
      description: "Prepare role assignment suggestion",
      error: "workflow_id or current_workflow_id is required for validation-grounded role assignment",
    };
  }
  if (!role) {
    return {
      action: "role.update",
      params: baseParams,
      status: "failed",
      description: "Prepare role assignment suggestion",
      error: "role is required",
    };
  }

  const workflow = await getWorkflow(workflowId);
  if (!workflow) {
    return {
      action: "role.update",
      params: baseParams,
      status: "failed",
      description: "Prepare role assignment suggestion",
      error: `Workflow "${workflowId}" not found`,
    };
  }

  const validation = await buildWorkflowValidationReceipt(workflow, "assistant.role_assignment");
  const matchingIssue = [...validation.errors, ...validation.warnings].find(issue => (
    issue.class === "role" &&
    ROLE_ASSIGNMENT_VALIDATION_CODES.has(issue.code) &&
    issue.details?.role === role &&
    (!suggestion.element_id || issue.element_id === suggestion.element_id)
  ));
  if (!matchingIssue) {
    return {
      action: "role.update",
      params: baseParams,
      status: "failed",
      description: "Prepare role assignment suggestion",
      error: `No current workflow.validate role error for role "${role}"`,
      result: {
        workflow_id: workflowId,
        role,
        validation_source: validation.source,
        validation_readiness: validation.readiness,
      },
    };
  }

  const roles = await listRoles();
  const existingRole = roles.find(item => item.role_id === role);
  const assignees = suggestion.manual_queue
    ? []
    : suggestion.assignees && suggestion.assignees.length > 0
    ? suggestion.assignees
    : suggestion.assignee
    ? [suggestion.assignee]
    : [];
  if (!suggestion.manual_queue && assignees.length === 0) {
    return {
      action: existingRole ? "role.update" : "role.create",
      params: { ...baseParams, validation_issue_code: matchingIssue.code },
      status: "failed",
      description: "Prepare role assignment suggestion",
      error: "assignee or assignees is required unless manual_queue=true",
    };
  }

  const strategy = suggestion.manual_queue
    ? "manual"
    : normalizeAssignmentStrategy(suggestion.strategy, existingRole && existingRole.strategy !== "manual" ? existingRole.strategy : "round-robin");
  const action = existingRole ? "role.update" : "role.create";
  const actionArgs = action === "role.create"
    ? {
        role_id: role,
        name: role,
        assignees,
        strategy,
      }
    : {
        id: role,
        assignees,
        strategy,
      };
  const validationArgs = validateActionArgs(action, actionArgs);
  if (!validationArgs.valid) {
    return {
      action,
      params: actionArgs,
      status: "failed",
      description: "Prepare role assignment suggestion",
      error: validationArgs.errors.join("; "),
    };
  }

  const sessionId = opts.session_id ?? opts.chat_id;
  const agentChain = opts.agent_id ?? "tsunade";
  await auditLog({
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    action_type: action,
    parameters: JSON.stringify({
      ...actionArgs,
      grounded_by: {
        workflow_id: workflowId,
        validation_source: validation.source,
        validation_issue_code: matchingIssue.code,
        element_id: matchingIssue.element_id,
      },
    }),
    result: "requires_confirm",
    agent_chain: agentChain,
  }).catch(() => {});

  return {
    action,
    params: actionArgs,
    status: "needs_confirm",
    description: suggestion.manual_queue
      ? `Mark role "${role}" as explicit manual queue requires confirmation`
      : `Assign role "${role}" requires confirmation`,
    result: {
      workflow_id: workflowId,
      role,
      validation_issue_code: matchingIssue.code,
      element_id: matchingIssue.element_id,
    },
  };
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

function toDurableWorkflowPatch(schemaPatch: Record<string, unknown>): { patch: Record<string, unknown> | null; error?: string; unsupported_keys: string[] } {
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
  const controlKeys = [
    "id",
    "workflow_id",
    "process_id",
    "expected_edit_version",
    "expected_deploy_version",
  ];
  const supportedSet = new Set([...supportedKeys, ...controlKeys, "update_positions"]);
  const unsupportedKeys = Object.keys(schemaPatch).filter(key => !supportedSet.has(key));
  const patch: Record<string, unknown> = {};
  for (const key of supportedKeys) {
    if (Object.prototype.hasOwnProperty.call(schemaPatch, key)) {
      patch[key] = schemaPatch[key];
    }
  }
  const positionUpdates = durablePositionUpdates(schemaPatch.update_positions);
  if (positionUpdates.error) return { patch: null, error: positionUpdates.error, unsupported_keys: unsupportedKeys };
  if (positionUpdates.length > 0) {
    const existing = Array.isArray(patch.update_elements)
      ? patch.update_elements.filter(item => item && typeof item === "object") as Record<string, unknown>[]
      : [];
    const byId = new Map<string, Record<string, unknown>>();
    for (const item of existing) {
      if (typeof item.id === "string" && item.id.trim()) byId.set(item.id, item);
    }
    for (const item of positionUpdates) {
      const current = byId.get(item.id);
      byId.set(item.id, current ? { ...current, x: item.x, y: item.y } : item);
    }
    patch.update_elements = [...byId.values()];
  }
  return { patch: Object.keys(patch).length > 0 ? patch : null, unsupported_keys: unsupportedKeys };
}

type DurablePositionUpdates = Array<{ id: string; x: number; y: number }> & { error?: string };

function durablePositionUpdates(raw: unknown): DurablePositionUpdates {
  const updates: DurablePositionUpdates = [] as unknown as DurablePositionUpdates;
  if (raw === undefined) return updates;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    updates.error = "update_positions must be an object of element id to finite numeric x/y";
    return updates;
  }
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!id.trim() || !value || typeof value !== "object" || Array.isArray(value)) {
      updates.error = `update_positions.${id || "<empty>"} must be an object with finite numeric x/y`;
      return updates;
    }
    const pos = value as Record<string, unknown>;
    if (typeof pos.x === "number" && Number.isFinite(pos.x) && typeof pos.y === "number" && Number.isFinite(pos.y)) {
      updates.push({ id, x: pos.x, y: pos.y });
    } else {
      updates.error = `update_positions.${id} must include finite numeric x and y`;
      return updates;
    }
  }
  return updates;
}

async function executeWorkflowPatchFromSchema(
  schemaPatch: unknown,
  opts: NormalizeOptions,
): Promise<AssistantAction | null> {
  if (!schemaPatch || typeof schemaPatch !== "object" || Array.isArray(schemaPatch)) return null;
  const rawPatch = schemaPatch as Record<string, unknown>;
  const workflowId = schemaPatchTargetId(rawPatch, opts);
  const durablePatch = toDurableWorkflowPatch(rawPatch);
  const patch = durablePatch.patch;

  if (durablePatch.error) {
    return {
      action: "workflow.patch",
      params: {
        ...(workflowId ? { id: workflowId } : {}),
        invalid_schema_patch: true,
      },
      status: "failed",
      description: "Reject malformed schema patch before durable workflow.patch",
      error: durablePatch.error,
      result: {
        ok: false,
        code: "WORKFLOW_PATCH_INVALID",
        error: durablePatch.error,
        ...(workflowId ? { workflow_id: workflowId } : {}),
        failure_reasons: [durablePatch.error],
        attempted_resources: workflowId ? [{ kind: "workflow", id: workflowId, change: "failed" }] : [],
      },
    };
  }

  if (!workflowId || !patch) {
    if (workflowId && durablePatch.unsupported_keys.length > 0) {
      const error = `Unsupported schema_patch keys: ${durablePatch.unsupported_keys.join(", ")}`;
      return {
        action: "workflow.patch",
        params: {
          id: workflowId,
          unsupported_schema_keys: durablePatch.unsupported_keys,
        },
        status: "failed",
        description: "Reject unsupported schema patch before durable workflow.patch",
        error,
        result: {
          ok: false,
          code: "WORKFLOW_PATCH_UNSUPPORTED",
          error,
          workflow_id: workflowId,
          unsupported_schema_keys: durablePatch.unsupported_keys,
          failure_reasons: durablePatch.unsupported_keys.map(key => `schema_patch.${key} is not supported by workflow.patch`),
          attempted_resources: durablePatch.unsupported_keys.map(key => ({
            kind: "workflow",
            id: workflowId,
            label: `schema_patch.${key}`,
            change: "failed",
          })),
        },
      };
    }
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
    ...(typeof rawPatch.expected_edit_version === "number" ? { expected_edit_version: rawPatch.expected_edit_version } : {}),
    ...(typeof rawPatch.expected_deploy_version === "number" ? { expected_deploy_version: rawPatch.expected_deploy_version } : {}),
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
      result: {
        ...(result.data as Record<string, unknown>),
        ...(durablePatch.unsupported_keys.length > 0 ? {
          assistant_partial_failure: true,
          unsupported_schema_keys: durablePatch.unsupported_keys,
          failure_reasons: durablePatch.unsupported_keys.map(key => `schema_patch.${key} is not supported by workflow.patch`),
          attempted_resources: durablePatch.unsupported_keys.map(key => ({
            kind: "workflow",
            id: workflowId,
            label: `schema_patch.${key}`,
            change: "failed",
          })),
        } : {}),
      },
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

function workflowIdForAction(action: AssistantAction): string {
  const result = action.result ?? {};
  const params = action.params ?? {};
  for (const value of [
    result.workflow_id,
    result.process_id,
    result.id,
    params.id,
    params.process_id,
  ]) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return action.action;
}

function changedResourceForAction(action: AssistantAction, status: ActionReceipt["status"]): ActionReceiptResource {
  const change = status === "succeeded" ? "updated" : status === "pending_confirmation" ? "pending" : "failed";
  if (action.action.startsWith("role.")) {
    const roleId = typeof action.result?.role_id === "string"
      ? action.result.role_id
      : typeof action.params.role_id === "string"
      ? action.params.role_id
      : typeof action.params.id === "string"
      ? action.params.id
      : action.action;
    return {
      kind: "role",
      id: roleId,
      ...(typeof action.params.name === "string" ? { label: action.params.name } : {}),
      change,
    };
  }
  return {
    kind: "workflow",
    id: workflowIdForAction(action),
    change,
  };
}

function readinessSummary(result: Record<string, unknown> | undefined): string | undefined {
  if (!result) return undefined;
  const validation = isRecord(result.validation) ? result.validation : result;
  const readiness = typeof validation.readiness === "string" ? validation.readiness : undefined;
  const errors = Array.isArray(validation.errors) ? validation.errors.length : undefined;
  if (!readiness) return undefined;
  return errors === undefined ? `readiness=${readiness}` : `readiness=${readiness}; errors=${errors}`;
}

function buildActionSequenceReceipt(
  action: AssistantAction,
  opts: NormalizeOptions,
  status: ActionReceipt["status"],
): ActionReceipt {
  const result = action.result && typeof action.result === "object" ? action.result : {};
  const summaryDetails = readinessSummary(result);
  const actionLabel = action.action;
  const summary =
    status === "succeeded"
      ? `${actionLabel} выполнено${summaryDetails ? ` (${summaryDetails})` : ""}.`
      : status === "pending_confirmation"
      ? `${actionLabel} ожидает подтверждения.`
      : `${actionLabel} завершилось ошибкой.`;

  return {
    id: randomUUID(),
    action: action.action,
    status,
    summary,
    ...(action.error || typeof result.error === "string" ? { details: action.error ?? String(result.error) } : {}),
    ...(action.error ? { failure_reasons: [action.error] } : {}),
    changed_resources: [changedResourceForAction(action, status)],
    audit: {
      session_id: opts.session_id ?? opts.chat_id,
      action_type: action.action,
    },
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

function buildRoleAssignmentReceipt(
  action: AssistantAction,
  opts: NormalizeOptions,
  status: ActionReceipt["status"],
): ActionReceipt {
  const roleId = typeof action.params.role_id === "string"
    ? action.params.role_id
    : typeof action.params.id === "string"
    ? action.params.id
    : typeof action.result?.role === "string"
    ? action.result.role
    : "role.assignment";
  const assignees = Array.isArray(action.params.assignees)
    ? action.params.assignees.filter((item): item is string => typeof item === "string")
    : [];
  const strategy = typeof action.params.strategy === "string" ? action.params.strategy : undefined;
  const validationCode = typeof action.result?.validation_issue_code === "string"
    ? action.result.validation_issue_code
    : undefined;
  const elementId = typeof action.result?.element_id === "string" ? action.result.element_id : undefined;
  const details = [
    action.error,
    validationCode ? `grounded_by=${validationCode}` : undefined,
    elementId ? `element_id=${elementId}` : undefined,
  ].filter((item): item is string => Boolean(item)).join("; ");
  const assignmentLabel = strategy
    ? `${strategy}${assignees.length > 0 ? ` -> ${assignees.join(", ")}` : ""}`
    : undefined;

  return {
    id: randomUUID(),
    action: action.action,
    status,
    summary:
      status === "pending_confirmation"
        ? `Назначение роли "${roleId}" ожидает подтверждения оператора.`
        : `Предложение назначения роли "${roleId}" отклонено.`,
    ...(details ? { details } : {}),
    ...(action.error ? { failure_reasons: [action.error] } : {}),
    changed_resources: [
      {
        kind: "role",
        id: roleId,
        ...(assignmentLabel ? { label: assignmentLabel } : {}),
        change: status === "pending_confirmation" ? "pending" : "failed",
      },
    ],
    audit: {
      session_id: opts.session_id ?? opts.chat_id,
      action_type: action.action,
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
  const rawAttempts = Array.isArray(result.attempted_resources)
    ? result.attempted_resources as Record<string, unknown>[]
    : [];
  const failureReasons = Array.isArray(result.failure_reasons)
    ? result.failure_reasons.filter(reason => typeof reason === "string") as string[]
    : Array.isArray(result.details) && result.details.every(reason => typeof reason === "string")
    ? result.details as string[]
    : typeof result.code === "string" && typeof result.error === "string"
    ? [`${result.code}: ${result.error}`]
    : [];
  const mapResource = (change: Record<string, unknown>, forceFailed = false): ActionReceiptResource => {
    const rawKind = typeof change.kind === "string" ? change.kind : "workflow";
    const kind = rawKind === "flow" ? "flow" : rawKind === "workflow" ? "workflow" : "element";
    const rawChange = typeof change.change === "string" ? change.change : "updated";
    const mappedChange =
      forceFailed || status === "failed"
        ? "failed"
        : status === "pending_confirmation"
        ? "pending"
        : rawChange === "created"
        ? "created"
        : "updated";
    return {
      kind,
      id: typeof change.id === "string" ? change.id : workflowId,
      ...(typeof change.label === "string" ? { label: change.label } : {}),
      change: mappedChange,
    };
  };
  const changedResources: ActionReceiptResource[] = rawChanges
    .map(change => mapResource(change));
  const attemptedResources = rawAttempts.map(change => mapResource(change, true));
  if (status === "partial" || (status === "failed" && changedResources.length === 0)) {
    changedResources.push(...attemptedResources);
  }
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
        : status === "partial"
        ? `Изменение процесса выполнено частично: ${rawChanges.length} сохранено, ${attemptedResources.length} отклонено.`
        : status === "pending_confirmation"
        ? `Изменение процесса ожидает подтверждения.`
        : `Изменение процесса отклонено серверной проверкой.`,
    ...(action.error || typeof result.error === "string" ? { details: action.error ?? String(result.error) } : {}),
    ...(failureReasons.length > 0 ? { failure_reasons: failureReasons } : {}),
    changed_resources: changedResources,
    ...(attemptedResources.length > 0 ? { attempted_resources: attemptedResources } : {}),
    audit: {
      session_id: opts.session_id ?? opts.chat_id,
      action_type: "workflow.patch",
    },
  };
}

function buildAssistantEditResult(
  action: AssistantAction,
  mode: AssistantEditMode,
  receipt?: ActionReceipt,
): AssistantEditResult {
  const workflowId = typeof action.result?.workflow_id === "string"
    ? action.result.workflow_id
    : typeof action.params.id === "string"
    ? action.params.id
    : undefined;
  return {
    kind: "schema_patch",
    mode,
    durable: mode === "committed",
    action: "workflow.patch",
    summary:
      mode === "committed"
        ? "Schema patch was committed durably through workflow.patch."
        : mode === "pending_confirmation"
        ? "Schema patch is waiting for workflow.patch confirmation."
        : mode === "failed"
        ? "Schema patch was rejected before durable commit."
        : "Schema patch is preview-only and has not been committed.",
    ...(workflowId ? { workflow_id: workflowId } : {}),
    ...(receipt ? { receipt_id: receipt.id } : {}),
    ...(action.error ? { error: action.error } : {}),
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
  if (parsed.role_assignment_suggestions || parsed.role_assignments || parsed.role_assignment || parsed["role.assign"]) {
    return "Подготовил предложение назначения роли.";
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
    edit_result: resp.edit_result,
    created_workflow: resp.created_workflow,
    actions: resp.ui_actions,
    actions_taken: resp.actions_taken,
    pending_confirmations: resp.pending_confirmations,
    action_receipts: resp.action_receipts,
    observable_result: resp.observable_result,
  };
}
