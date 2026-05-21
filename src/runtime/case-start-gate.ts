import {
  getWorkflowLifecycleState,
  isWorkflowExecutable,
  validateWorkflowReadiness,
  WORKFLOW_VALIDATION_TAXONOMY_VERSION,
  type WorkflowDefinition,
  type WorkflowValidationReceipt,
} from "../workflow-loader";
import { listRoles } from "./roles";
import { listDocs } from "./documents";
import { listAdapters } from "../adapters";

export interface CaseStartGateFailure {
  status: 409;
  data: Record<string, unknown>;
}

export interface CaseStartGateOptions {
  adminOverride?: boolean;
  source?: string;
}

export class CaseStartGateError extends Error {
  readonly status: number;
  readonly data: Record<string, unknown>;

  constructor(failure: CaseStartGateFailure) {
    super(String(failure.data.error ?? "Workflow blocks case start"));
    this.name = "CaseStartGateError";
    this.status = failure.status;
    this.data = failure.data;
  }
}

export async function buildCaseStartValidationReceipt(
  workflow: WorkflowDefinition,
  source = "case.start",
): Promise<WorkflowValidationReceipt> {
  const [roles, documents] = await Promise.all([
    listRoles(),
    listDocs(),
  ]);
  return validateWorkflowReadiness(workflow, {
    roles,
    documents,
    adapters: listAdapters(),
    source,
  });
}

export async function evaluateCaseStartGate(
  workflow: WorkflowDefinition,
  options: CaseStartGateOptions = {},
): Promise<CaseStartGateFailure | null> {
  if (options.adminOverride === true) return null;

  const lifecycleState = getWorkflowLifecycleState(workflow);
  if (!isWorkflowExecutable(workflow)) {
    return {
      status: 409,
      data: {
        error: "Workflow is not executable",
        code: "WORKFLOW_NOT_EXECUTABLE",
        process_id: workflow.id,
        lifecycle_state: lifecycleState,
        status: workflow.status,
        required_lifecycle_state: "executable",
        admin_override_available: true,
        taxonomy_version: WORKFLOW_VALIDATION_TAXONOMY_VERSION,
        validation_issue: {
          code: "LIFECYCLE_NOT_EXECUTABLE",
          severity: "error",
          class: "lifecycle",
          message: "Workflow lifecycle state must be executable before case.start",
          details: { required_lifecycle_state: "executable", lifecycle_state: lifecycleState },
        },
      },
    };
  }

  const validation = await buildCaseStartValidationReceipt(workflow, options.source ?? "case.start");
  if (validation.errors.length > 0) {
    return {
      status: 409,
      data: {
        error: "Workflow readiness blocks case start",
        code: "WORKFLOW_READINESS_BLOCKED",
        process_id: workflow.id,
        lifecycle_state: lifecycleState,
        validation,
      },
    };
  }

  return null;
}

export async function assertCaseStartAllowed(
  workflow: WorkflowDefinition,
  options: CaseStartGateOptions = {},
): Promise<void> {
  const failure = await evaluateCaseStartGate(workflow, options);
  if (failure) throw new CaseStartGateError(failure);
}
