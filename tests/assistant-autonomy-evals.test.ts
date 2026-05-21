import { describe, expect, it } from "bun:test";
import {
  runOperatorBenchmarkScenario,
  getPrimaryObservableStatus,
} from "../src/operator-evals";
import { OPERATOR_STATE_VERSION, type OperatorStateEnvelope } from "../src/operator-state";
import { createWorkflow } from "../src/workflow-loader";
import { createRole, deleteRole } from "../src/runtime/roles";

const RUN = Date.now().toString(36);

function buildOperatorState(title: string): OperatorStateEnvelope {
  return {
    version: OPERATOR_STATE_VERSION,
    captured_at: "2026-04-29T11:00:00Z",
    current_view: {
      id: "process_editor",
      kind: "process_editor",
      route: "/editor/autonomy-evals",
      title,
      read_only: false,
      viewport: { width: 1440, height: 900, device_pixel_ratio: 1, is_mobile: false },
    },
    current_process: {
      workflow: {
        id: "autonomy-eval-space",
        name: "Autonomy Eval Space",
        is_known: false,
        viewing_version: null,
        breadcrumb: [],
        element_count: 3,
        edge_count: 2,
        elements: [
          { id: "start_event", type: "event", label: "Start", position: { x: 120, y: 120 }, trigger: { kind: "manual", action: "complete", role: "Operator", confidence: 1 } },
          { id: "task_approve", type: "function", label: "Approve", position: { x: 360, y: 120 }, role: "Manager" },
          { id: "end_event", type: "event", label: "End", position: { x: 600, y: 120 }, trigger: { kind: "manual", action: "complete", role: "System", confidence: 1 } },
        ],
        edges: [["start_event", "task_approve"], ["task_approve", "end_event"]],
        canvas: { pan_x: 0, pan_y: 0, zoom: 1 },
      },
      selection: { mode: "select", primary_selected_id: null, selected_ids: [], hovered_id: null, connect_from_id: null, editing_id: null, gateway_picker_id: null },
      pending: { saving: false, autosave_pending: false, trigger_resolving_ids: [], draft_warning: null, confirmations: [] },
      changes: { has_local_changes: false, undo_depth: 0, redo_depth: 0 },
      affordances: {
        can_edit: true, can_save: true, can_delete_selection: false, can_connect: true,
        actions: [
          { id: "workflow.update.current", action_id: "workflow.update", scope: "workflow", label: "Update workflow", description: "Update current workflow.", availability: "available", suggested_args: { id: "autonomy-eval-space" } },
          { id: "workflow.delete.current", action_id: "workflow.delete", scope: "workflow", label: "Delete workflow", description: "Archive this workflow.", availability: "available", suggested_args: { id: "autonomy-eval-space" } },
          { id: "element.add.canvas", action_id: "element.add", scope: "element", label: "Add element", description: "Add element to workflow.", availability: "available", suggested_args: { workflow_id: "autonomy-eval-space" } },
          { id: "case.start.canvas", action_id: "case.start", scope: "case", label: "Start case", description: "Start a new case.", availability: "available", suggested_args: { process_id: "autonomy-eval-space", subject: "Test case" } },
        ],
      },
      registries: { roles: ["Operator", "Manager"], documents: [], adapters: [] },
    },
  };
}

describe("assistant autonomy evals", () => {
  it("workflow.patch with auto autonomy persists through the server action", async () => {
    const workflowId = `autonomy-eval-update-${RUN}`;
    const roleId = `${workflowId}-role`;
    await createRole({ role_id: roleId, name: "Autonomy eval role", strategy: "manual", assignees: [] });
    await createWorkflow({
      id: workflowId,
      version: "1.0",
      name: "Autonomy Eval Space",
      elements: [
        { id: "start", type: "event", label: "Start", trigger: { kind: "manual", manual_override: true } },
        { id: "review", type: "function", label: "Review", role: roleId },
        { id: "done", type: "event", label: "End" },
      ],
      flow: [["start", "review"], ["review", "done"]],
    }, { draft: true });
    const result = await runOperatorBenchmarkScenario({
      id: `tsunade-update-${RUN}`,
      operator: "tsunade",
      message: "Update the workflow name.",
      operator_state: buildOperatorState("Autonomy Eval: Update"),
      raw_output: JSON.stringify({
        reply: "Updated workflow.",
        schema_patch: { set_name: "Updated Workflow", id: workflowId },
      }),
      autonomy_overrides: { "workflow.patch": "auto" },
    });

    expect(getPrimaryObservableStatus(result)).toBe("succeeded");
    expect(result.response.action_receipts.length).toBeGreaterThan(0);
    expect(result.response.action_receipts.some(r => r.action === "workflow.patch")).toBe(true);
    expect(result.audit_entries.some(e => e.action_type === "workflow.patch")).toBe(true);
    expect(result.materialized_workflows[0]?.name).toBe("Updated Workflow");
    await deleteRole(roleId).catch(() => {});
  });

  it("schema_patch without a durable target remains preview-only", async () => {
    const result = await runOperatorBenchmarkScenario({
      id: `tsunade-schema-patch-${RUN}`,
      operator: "tsunade",
      message: "Update the workflow trigger.",
      operator_state: buildOperatorState("Autonomy Eval: Schema Patch"),
      raw_output: JSON.stringify({
        reply: "Trigger updated.",
        schema_patch: { update_elements: [{ id: "start_event", trigger: { kind: "timer", config: { interval: "1d" } } }] },
      }),
    });

    expect(getPrimaryObservableStatus(result)).toBe("no_effect");
    expect(result.response.action_receipts.some(r => r.action === "workflow.update" && r.status === "succeeded")).toBe(false);
    expect(result.audit_entries.some(e => e.action_type === "workflow.update")).toBe(false);
  });

  it("workflow.create with auto materializes the workflow", async () => {
    const workflowId = `autonomy-eval-create-${RUN}`;
    const result = await runOperatorBenchmarkScenario({
      id: `tsunade-create-auto-${RUN}`,
      operator: "tsunade",
      message: "Create a new approval process.",
      operator_state: buildOperatorState("Autonomy Eval: Create Auto"),
      raw_output: JSON.stringify({
        reply: "Created draft approval process.",
        create_workflow: {
          id: workflowId,
          name: "Auto Approval Process",
          version: "1.0",
          elements: [{ id: "start", type: "event", label: "Start", trigger: { kind: "manual" } }],
          flow: [],
        },
      }),
      autonomy_overrides: { "workflow.create": "auto" },
    });

    expect(getPrimaryObservableStatus(result)).toBe("succeeded");
    expect(result.materialized_workflows).toHaveLength(1);
    expect(result.materialized_workflows[0].id).toBe(workflowId);
    expect(result.response.action_receipts.some(r => r.action === "workflow.create" && r.status === "succeeded")).toBe(true);
    expect(result.audit_entries.some(e => e.action_type === "workflow.create" && e.result === "ok")).toBe(true);
  });

  it("workflow.create with confirm does not materialize", async () => {
    const workflowId = `autonomy-eval-create-confirm-${RUN}`;
    const result = await runOperatorBenchmarkScenario({
      id: `tsunade-create-confirm-${RUN}`,
      operator: "tsunade",
      message: "Create a process but ask first.",
      operator_state: buildOperatorState("Autonomy Eval: Create Confirm"),
      raw_output: JSON.stringify({
        reply: "Prepared process creation, awaiting confirmation.",
        create_workflow: { id: workflowId, name: "Confirmed Process", version: "1.0", elements: [], flow: [] },
      }),
      autonomy_overrides: { "workflow.create": "confirm" },
    });

    expect(getPrimaryObservableStatus(result)).toBe("pending_confirmation");
    expect(result.materialized_workflows).toHaveLength(0);
    expect(result.response.pending_confirmations).toHaveLength(1);
    expect(result.response.pending_confirmations[0].action).toBe("workflow.create");
    expect(result.audit_entries.some(e => e.result === "requires_confirm")).toBe(true);
  });

  it("malformed output produces no_effect status safely", async () => {
    const result = await runOperatorBenchmarkScenario({
      id: `tsunade-malformed-${RUN}`,
      operator: "tsunade",
      message: "Try to do something.",
      operator_state: buildOperatorState("Autonomy Eval: Malformed"),
      raw_output: JSON.stringify({
        gibberish: ["nonsense", "no-op"],
        noise: true,
      }),
    });

    expect(getPrimaryObservableStatus(result)).toBe("no_effect");
    expect(result.response.action_receipts).toHaveLength(0);
    expect(result.materialized_workflows).toHaveLength(0);
    expect(result.audit_entries).toHaveLength(0);
  });
});
