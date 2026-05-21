import {
  getWorkflow,
  getWorkflowDeployedSnapshot,
  saveWorkflowDeployedSnapshot,
  type WorkflowDefinition,
  type WorkflowRuntimeSnapshotBinding,
} from "../../workflow-loader";
import type { Case } from "./types";

function isRuntimeSnapshotBinding(value: unknown): value is WorkflowRuntimeSnapshotBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.workflow_id === "string" &&
    typeof record.deploy_version === "number" &&
    typeof record.snapshot_key === "string" &&
    typeof record.bound_at === "string" &&
    typeof record.source === "string"
  );
}

export function workflowSnapshotBindingFromPayload(payload: Record<string, unknown>): WorkflowRuntimeSnapshotBinding | undefined {
  const raw = payload.__workflow_snapshot;
  return isRuntimeSnapshotBinding(raw) ? raw : undefined;
}

export function payloadWithWorkflowSnapshot(
  payload: Record<string, unknown>,
  binding: WorkflowRuntimeSnapshotBinding | undefined,
): Record<string, unknown> {
  if (!binding) return payload;
  return { ...payload, __workflow_snapshot: binding };
}

export async function bindWorkflowSnapshotForCase(def: WorkflowDefinition): Promise<WorkflowRuntimeSnapshotBinding> {
  return saveWorkflowDeployedSnapshot(def, def.last_deploy?.source ?? "case.start");
}

export async function loadWorkflowForCase(kase: Pick<Case, "process_id" | "workflow_snapshot">): Promise<WorkflowDefinition | null> {
  if (kase.workflow_snapshot) {
    return getWorkflowDeployedSnapshot(kase.workflow_snapshot);
  }
  return getWorkflow(kase.process_id);
}
