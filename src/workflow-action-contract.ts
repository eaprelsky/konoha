/**
 * Canonical workflow action/observable-result contract.
 *
 * This is the server-side source of truth for the shape returned by Tsunade,
 * /api/ai/chat SSE parsed events, and agent-facing workflow actions.
 */

export type WorkflowActionType =
  | "workflow.create"
  | "workflow.update"
  | "workflow.open"
  | "workflow.save"
  | "workflow.confirm"
  | "case.start";

export type WorkflowActionStatus = "executed" | "needs_confirm" | "failed" | "skipped";
export type WorkflowReceiptStatus = "succeeded" | "pending_confirmation" | "failed" | "partial";
export type WorkflowObservableStatus = WorkflowReceiptStatus | "no_effect";
export type WorkflowResourceKind = "workflow" | "element" | "flow" | "confirmation" | "case" | "work_item";
export type WorkflowResourceChange = "created" | "updated" | "opened" | "started" | "pending" | "failed";

export interface WorkflowAssistantAction {
  action: WorkflowActionType | string;
  params: Record<string, unknown>;
  status: WorkflowActionStatus;
  description: string;
  result?: Record<string, unknown>;
  error?: string;
}

export type ConfirmationStatus = "required" | "confirmed" | "cancelled" | "expired";

export interface WorkflowPendingConfirmation {
  id: string;
  action: WorkflowActionType | string;
  title: string;
  summary: string;
  status: ConfirmationStatus;
  permission: {
    actor_scope: "assistant_on_behalf_of_user";
    autonomy: "confirm";
    confirmation_required: true;
  };
  params: Record<string, unknown>;
  created_at?: string;
  expires_at?: string;
  chat_id?: string;
}

export interface WorkflowActionReceiptResource {
  kind: WorkflowResourceKind;
  id: string;
  label?: string;
  change: WorkflowResourceChange;
}

export interface WorkflowActionReceipt {
  id: string;
  action: WorkflowActionType | string;
  status: WorkflowReceiptStatus;
  summary: string;
  details?: string;
  changed_resources: WorkflowActionReceiptResource[];
  audit: {
    session_id: string;
    action_type: WorkflowActionType | string;
  };
}

export interface WorkflowObservableResult {
  status: WorkflowObservableStatus;
  summary: string;
  receipts: WorkflowActionReceipt[];
  counts: {
    succeeded: number;
    pending_confirmation: number;
    failed: number;
    partial: number;
  };
}

export function buildWorkflowObservableResult(receipts: WorkflowActionReceipt[]): WorkflowObservableResult {
  const counts = {
    succeeded: receipts.filter((receipt) => receipt.status === "succeeded").length,
    pending_confirmation: receipts.filter((receipt) => receipt.status === "pending_confirmation").length,
    failed: receipts.filter((receipt) => receipt.status === "failed").length,
    partial: receipts.filter((receipt) => receipt.status === "partial").length,
  };

  const status: WorkflowObservableResult["status"] =
    counts.failed > 0 && (counts.succeeded > 0 || counts.pending_confirmation > 0 || counts.partial > 0)
      ? "partial"
      : counts.failed > 0
      ? "failed"
      : counts.pending_confirmation > 0
      ? "pending_confirmation"
      : counts.succeeded > 0 || counts.partial > 0
      ? "succeeded"
      : "no_effect";

  return {
    status,
    summary: receipts.length === 0
      ? "Изменений не зафиксировано."
      : receipts.map((receipt) => receipt.summary).join(" "),
    receipts,
    counts,
  };
}
