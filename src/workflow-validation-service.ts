import { listAdapters } from "./adapters";
import { listCases } from "./runtime";
import { listDocs } from "./runtime/documents";
import { listRoles } from "./runtime/roles";
import {
  validateWorkflowReadiness,
  type WorkflowDefinition,
  type WorkflowValidationReceipt,
} from "./workflow-loader";

export async function buildWorkflowValidationReceipt(
  workflow: WorkflowDefinition,
  source = "workflow.validate",
): Promise<WorkflowValidationReceipt> {
  const [roles, documents, runningCases] = await Promise.all([
    listRoles(),
    listDocs(),
    listCases({ process_id: workflow.id, status: "running", limit: 1 }).catch(() => ({ cases: [], total: 0 })),
  ]);

  return validateWorkflowReadiness(workflow, {
    roles,
    documents,
    adapters: listAdapters(),
    running_case_count: runningCases.total,
    source,
  });
}
