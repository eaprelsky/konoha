import type { WorkflowElement } from "../../workflow-loader";
import type { Case } from "./types";

export const SUBPROCESS_PARENT_COMPLETION_RETRY = {
  max_attempts: 3,
  initial_delay_ms: 500,
  backoff_multiplier: 2,
} as const;

export interface SubprocessSpawnEffect {
  kind: "subprocess.spawn";
  parent_case_id: string;
  parent_process_id: string;
  parent_subject: string;
  parent_work_item_id: string;
  element_id: string;
  element_label: string;
  child_process_id: string;
  child_subject: string;
  payload: Record<string, unknown>;
}

export interface SubprocessParentCompletionEffect {
  kind: "subprocess.parent_complete";
  child_case_id: string;
  child_process_id: string;
  parent_case_id?: string;
  parent_work_item_id: string;
  output: Record<string, unknown>;
  retry: typeof SUBPROCESS_PARENT_COMPLETION_RETRY;
}

export type SubprocessTransitionEffect =
  | SubprocessSpawnEffect
  | SubprocessParentCompletionEffect;

export function buildSubprocessSpawnEffect(params: {
  parentCase: Pick<Case, "case_id" | "process_id" | "subject" | "payload">;
  elementId: string;
  element: Pick<WorkflowElement, "label">;
  childProcessId: string;
  parentWorkItemId: string;
}): SubprocessSpawnEffect {
  return {
    kind: "subprocess.spawn",
    parent_case_id: params.parentCase.case_id,
    parent_process_id: params.parentCase.process_id,
    parent_subject: params.parentCase.subject,
    parent_work_item_id: params.parentWorkItemId,
    element_id: params.elementId,
    element_label: params.element.label,
    child_process_id: params.childProcessId,
    child_subject: `${params.parentCase.subject} → ${params.element.label}`,
    payload: { ...params.parentCase.payload },
  };
}

export function buildSubprocessParentCompletionEffect(
  childCase: Pick<Case, "case_id" | "process_id" | "parent_case_id" | "parent_work_item_id" | "payload">,
): SubprocessParentCompletionEffect | null {
  if (!childCase.parent_work_item_id) return null;
  return {
    kind: "subprocess.parent_complete",
    child_case_id: childCase.case_id,
    child_process_id: childCase.process_id,
    parent_case_id: childCase.parent_case_id,
    parent_work_item_id: childCase.parent_work_item_id,
    output: { ...childCase.payload },
    retry: SUBPROCESS_PARENT_COMPLETION_RETRY,
  };
}
