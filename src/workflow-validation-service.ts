import { listAdapters } from "./adapters";
import { listCases } from "./runtime";
import { listDocs } from "./runtime/documents";
import { listRoles } from "./runtime/roles";
import { listAgents } from "./redis";
import { listPeople } from "./people-directory";
import {
  validateWorkflowReadiness,
  type WorkflowDefinition,
  type WorkflowValidationReceipt,
} from "./workflow-loader";

export async function buildWorkflowValidationReceipt(
  workflow: WorkflowDefinition,
  source = "workflow.validate",
): Promise<WorkflowValidationReceipt> {
  const [roles, documents, runningCases, agents, people] = await Promise.all([
    listRoles(),
    listDocs(),
    listCases({ process_id: workflow.id, status: "running", limit: 1 }).catch(() => ({ cases: [], total: 0 })),
    listAgents(false).catch(() => undefined),
    listPeople().catch(() => undefined),
  ]);

  return validateWorkflowReadiness(workflow, {
    roles,
    documents,
    adapters: listAdapters(),
    ...(agents ? { agents } : {}),
    ...(people ? { people } : {}),
    running_case_count: runningCases.total,
    source,
  });
}
