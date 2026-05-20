import type { RoleDef } from "../src/runtime/roles";
import type { Case, WorkItem } from "../src/runtime/cases/types";
import type { WorkflowDefinition } from "../src/workflow-loader";
import { createTestNamespace } from "./test-namespace";

let seq = 0;
const factoryNamespace = createTestNamespace("factory");

function nextId(prefix: string): string {
  seq += 1;
  return factoryNamespace.id(`${prefix}-${seq}`);
}

export function makeRoleDef(overrides: Partial<RoleDef> = {}): RoleDef {
  const now = "2026-04-16T00:00:00.000Z";
  return {
    role_id: overrides.role_id ?? nextId("role"),
    name: overrides.name ?? "Operator",
    description: overrides.description ?? "Test role",
    assignees: overrides.assignees ?? [],
    strategy: overrides.strategy ?? "manual",
    required_capabilities: overrides.required_capabilities ?? [],
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
  };
}

export function makeCase(overrides: Partial<Case> = {}): Case {
  const now = "2026-04-16T00:00:00.000Z";
  return {
    case_id: overrides.case_id ?? nextId("case"),
    process_id: overrides.process_id ?? nextId("process"),
    process_version: overrides.process_version ?? "1.0",
    subject: overrides.subject ?? "Test subject",
    status: overrides.status ?? "running",
    position: overrides.position ?? "start",
    active_branches: overrides.active_branches,
    payload: overrides.payload ?? {},
    history: overrides.history ?? [],
    created_at: overrides.created_at ?? now,
    parent_work_item_id: overrides.parent_work_item_id,
    parent_case_id: overrides.parent_case_id,
    needs_attention: overrides.needs_attention,
  };
}

export function makeWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  const now = "2026-04-16T00:00:00.000Z";
  return {
    work_item_id: overrides.work_item_id ?? nextId("wi"),
    case_id: overrides.case_id ?? nextId("case"),
    process_id: overrides.process_id ?? nextId("process"),
    element_id: overrides.element_id ?? "fn-1",
    label: overrides.label ?? "Review request",
    assignee: overrides.assignee ?? "operator",
    status: overrides.status ?? "pending",
    input: overrides.input ?? {},
    output: overrides.output,
    deadline: overrides.deadline,
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
    child_case_id: overrides.child_case_id,
  };
}

export function makeWorkflowDefinition(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: overrides.id ?? nextId("wf"),
    version: overrides.version ?? "1.0",
    name: overrides.name ?? "Test Workflow",
    description: overrides.description,
    triggers: overrides.triggers,
    elements: overrides.elements ?? [
      { id: "event_start", type: "event", label: "Start" },
      { id: "fn_1", type: "function", label: "Review request", role: "Operator" },
      { id: "event_end", type: "event", label: "Done" },
    ],
    flow: overrides.flow ?? [["event_start", "fn_1"], ["fn_1", "event_end"]],
    parent_id: overrides.parent_id,
    parent_function_id: overrides.parent_function_id,
  };
}
