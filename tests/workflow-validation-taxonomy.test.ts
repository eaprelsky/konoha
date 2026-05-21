import { describe, expect, test } from "bun:test";
import { evaluateCaseStartGate } from "../src/runtime/case-start-gate";
import {
  WORKFLOW_VALIDATION_TAXONOMY_VERSION,
  validateWorkflow,
  validateWorkflowReadiness,
  type WorkflowDefinition,
} from "../src/workflow-loader";
import { makeWorkflowDefinition } from "./factories";

function workflowWith(elements: WorkflowDefinition["elements"], flow: WorkflowDefinition["flow"]): WorkflowDefinition {
  return makeWorkflowDefinition({ elements, flow });
}

describe("workflow validation taxonomy", () => {
  test("validateWorkflow emits source-level stable codes without parsing messages", () => {
    const errors = validateWorkflow(workflowWith(
      [
        { id: "start", type: "event", label: "Start" },
        { id: "next", type: "event", label: "Next" },
      ],
      [["start", "next"]],
    ));

    expect(errors).toContainEqual(expect.objectContaining({
      rule: 2,
      code: "GRAPH_ALTERNATION_VIOLATION",
      class: "graph",
      edge: ["start", "next"],
    }));
  });

  test("readiness receipt covers graph, role, trigger, adapter, document, deployment, and migration groups", () => {
    const graphReceipt = validateWorkflowReadiness(workflowWith(
      [
        { id: "start", type: "event", label: "Start" },
        { id: "task", type: "function", label: "Task", role: "Operator" },
        { id: "done", type: "event", label: "Done" },
      ],
      [["start", "task"], ["task", "missing"]],
    ));
    expect(graphReceipt.taxonomy_version).toBe(WORKFLOW_VALIDATION_TAXONOMY_VERSION);
    expect(graphReceipt.errors).toContainEqual(expect.objectContaining({
      code: "GRAPH_INVALID_EDGE_ENDPOINT",
      class: "graph",
    }));

    const roleReceipt = validateWorkflowReadiness(makeWorkflowDefinition(), {
      roles: [{ role_id: "Operator", assignees: [], strategy: "round-robin" }],
    });
    expect(roleReceipt.errors).toContainEqual(expect.objectContaining({
      code: "ROLE_MISSING_ASSIGNEE",
      class: "role",
      legacy_code: "RUNTIME_MISSING_ROLE_ASSIGNEE",
    }));

    const triggerReceipt = validateWorkflowReadiness(makeWorkflowDefinition({
      elements: [
        { id: "event_start", type: "event", label: "Start", trigger: { kind: "webhook" } as any },
        { id: "fn_1", type: "function", label: "Task", role: "Operator" },
        { id: "event_end", type: "event", label: "Done" },
      ],
    }));
    expect(triggerReceipt.errors).toContainEqual(expect.objectContaining({
      code: "TRIGGER_UNSUPPORTED_KIND",
      class: "trigger",
      legacy_code: "DEPLOYMENT_UNSUPPORTED_TRIGGER",
    }));

    const adapterReceipt = validateWorkflowReadiness(makeWorkflowDefinition({
      elements: [
        { id: "event_start", type: "event", label: "Start", trigger: { kind: "manual", manual_override: true } },
        { id: "fn_1", type: "function", label: "Task", role: "Operator", systems: [{ connector: "missing", operation: "send" }] },
        { id: "event_end", type: "event", label: "Done" },
      ],
    }), { adapters: [] });
    expect(adapterReceipt.errors).toContainEqual(expect.objectContaining({
      code: "ADAPTER_MISSING",
      class: "adapter",
      legacy_code: "RUNTIME_MISSING_ADAPTER",
    }));

    const documentReceipt = validateWorkflowReadiness(makeWorkflowDefinition({
      elements: [
        { id: "event_start", type: "event", label: "Start", trigger: { kind: "manual", manual_override: true } },
        { id: "fn_1", type: "function", label: "Task", role: "Operator", documents: ["missing.doc"] },
        { id: "event_end", type: "event", label: "Done" },
      ],
    }), { documents: [] });
    expect(documentReceipt.errors).toContainEqual(expect.objectContaining({
      code: "DOCUMENT_MISSING",
      class: "document",
      legacy_code: "RUNTIME_MISSING_DOCUMENT",
    }));

    const deploymentReceipt = validateWorkflowReadiness(makeWorkflowDefinition({
      elements: [
        { id: "event_start", type: "event", label: "Start", trigger: { kind: "manual", manual_override: true, confidence: 0.4 } },
        { id: "fn_1", type: "function", label: "Task", role: "Operator" },
        { id: "event_end", type: "event", label: "Done" },
      ],
    }));
    expect(deploymentReceipt.errors).toContainEqual(expect.objectContaining({
      code: "DEPLOYMENT_TRIGGER_REVIEW_REQUIRED",
      class: "deployment",
    }));

    const migrationReceipt = validateWorkflowReadiness(makeWorkflowDefinition(), { running_case_count: 2 });
    expect(migrationReceipt.warnings).toContainEqual(expect.objectContaining({
      code: "MIGRATION_RUNNING_CASES_PRESENT",
      class: "migration",
    }));
  });

  test("case.start lifecycle gate exposes a taxonomy issue while preserving outer error code", async () => {
    const failure = await evaluateCaseStartGate({
      ...makeWorkflowDefinition(),
      status: "validated",
      lifecycle_state: "validated",
    });

    expect(failure?.data).toMatchObject({
      code: "WORKFLOW_NOT_EXECUTABLE",
      taxonomy_version: WORKFLOW_VALIDATION_TAXONOMY_VERSION,
      validation_issue: {
        code: "LIFECYCLE_NOT_EXECUTABLE",
        class: "lifecycle",
      },
    });
  });
});
