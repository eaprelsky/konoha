import type { AutonomyLevel, AuditEntry } from "./assistant-actions";
import { AUDIT_STREAM } from "./assistant-actions";
import {
  buildSseParsedEvent,
  normalizeAssistantResponse,
  type AssistantResponse,
} from "./assistant-response";
import type { WorkflowObservableResult } from "./workflow-action-contract";
import {
  OPERATOR_STATE_VERSION,
  isOperatorStateEnvelope,
  type OperatorStateEnvelope,
} from "./operator-state";
import { redis } from "./redis";
import { WORKFLOW_INDEX_KEY, getWorkflow, type WorkflowDefinition } from "./workflow-loader";

export interface OperatorBenchmarkScenario {
  id: string;
  operator: string;
  message: string;
  raw_output: string;
  operator_state: OperatorStateEnvelope;
  autonomy_overrides?: Partial<Record<string, AutonomyLevel>>;
  cleanup_workflows?: boolean;
}

export interface OperatorBenchmarkResult {
  scenario_id: string;
  operator: string;
  state_version: typeof OPERATOR_STATE_VERSION;
  response: AssistantResponse;
  parsed_event: Record<string, unknown>;
  materialized_workflows: WorkflowDefinition[];
  audit_entries: AuditEntry[];
}

function stripMarkdownFences(raw: string): string {
  const match = raw.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/);
  return match ? match[1].trim() : raw;
}

function extractRequestedWorkflowIds(rawOutput: string): string[] {
  try {
    const parsed = JSON.parse(stripMarkdownFences(rawOutput)) as Record<string, unknown>;
    const createWorkflow = parsed.create_workflow;
    if (createWorkflow && typeof createWorkflow === "object" && typeof (createWorkflow as Record<string, unknown>).id === "string") {
      return [(createWorkflow as Record<string, unknown>).id as string];
    }
  } catch {}
  return [];
}

async function readAuditEntries(sessionId: string): Promise<AuditEntry[]> {
  const rows = await redis.xrevrange(AUDIT_STREAM, "+", "-", "COUNT", 50).catch(() => [] as [string, string[]][]);
  const entries: AuditEntry[] = [];
  for (const [, fields] of rows) {
    const entry: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) entry[fields[i]] = fields[i + 1];
    if (entry.session_id === sessionId) {
      entries.push(entry as unknown as AuditEntry);
    }
  }
  return entries.reverse();
}

async function cleanupWorkflowArtifacts(workflowIds: string[]): Promise<void> {
  for (const workflowId of workflowIds) {
    await redis.del(`workflow:${workflowId}`).catch(() => {});
    await redis.srem(WORKFLOW_INDEX_KEY, workflowId).catch(() => {});
    await redis.del(`konoha:workflow:versionctr:${workflowId}`).catch(() => {});
  }
}

export async function runOperatorBenchmarkScenario(
  scenario: OperatorBenchmarkScenario,
): Promise<OperatorBenchmarkResult> {
  if (!isOperatorStateEnvelope(scenario.operator_state)) {
    throw new Error(`Scenario "${scenario.id}" must provide a valid canonical operator_state envelope`);
  }

  const sessionId = `operator-eval:${scenario.id}:${Date.now()}`;
  const response = await normalizeAssistantResponse(scenario.raw_output, {
    chat_id: scenario.id,
    execute_actions: true,
    agent_id: scenario.operator,
    session_id: sessionId,
    autonomy_overrides: scenario.autonomy_overrides,
  });
  const parsedEvent = buildSseParsedEvent(response);

  const workflowIds = new Set<string>(extractRequestedWorkflowIds(scenario.raw_output));
  if (response.created_workflow?.id) workflowIds.add(response.created_workflow.id);

  const materializedWorkflows: WorkflowDefinition[] = [];
  for (const workflowId of workflowIds) {
    const workflow = await getWorkflow(workflowId);
    if (workflow) materializedWorkflows.push(workflow);
  }

  const auditEntries = await readAuditEntries(sessionId);

  if (scenario.cleanup_workflows !== false && workflowIds.size > 0) {
    await cleanupWorkflowArtifacts([...workflowIds]);
  }

  return {
    scenario_id: scenario.id,
    operator: scenario.operator,
    state_version: scenario.operator_state.version,
    response,
    parsed_event: parsedEvent,
    materialized_workflows: materializedWorkflows,
    audit_entries: auditEntries,
  };
}

export function getPrimaryObservableStatus(result: OperatorBenchmarkResult): WorkflowObservableResult["status"] {
  return result.response.observable_result.status;
}
