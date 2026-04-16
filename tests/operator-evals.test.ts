import { describe, expect, it } from "bun:test";
import { getPrimaryObservableStatus, runOperatorBenchmarkScenario } from "../src/operator-evals";
import { OPERATOR_STATE_VERSION, type OperatorStateEnvelope } from "../src/operator-state";

const RUN = Date.now().toString(36);

function buildOperatorState(title: string): OperatorStateEnvelope {
  return {
    version: OPERATOR_STATE_VERSION,
    captured_at: "2026-04-16T05:30:00Z",
    current_view: {
      id: "process_editor",
      kind: "process_editor",
      route: "/editor/operator-evals",
      title,
      read_only: false,
      viewport: {
        width: 1440,
        height: 900,
        device_pixel_ratio: 1,
        is_mobile: false,
      },
    },
    current_process: {
      workflow: {
        id: "operator-eval-space",
        name: "Operator Eval Space",
        is_known: false,
        viewing_version: null,
        breadcrumb: [],
        element_count: 1,
        edge_count: 0,
        elements: [
          {
            id: "start_event",
            type: "event",
            label: "Заявка получена",
            position: { x: 120, y: 120 },
            trigger: { kind: "manual", action: "complete", role: "Operator", confidence: 1 },
          },
        ],
        edges: [],
        canvas: {
          pan_x: 0,
          pan_y: 0,
          zoom: 1,
        },
      },
      selection: {
        mode: "select",
        primary_selected_id: "start_event",
        selected_ids: ["start_event"],
        hovered_id: null,
        connect_from_id: null,
        editing_id: null,
        gateway_picker_id: null,
      },
      pending: {
        saving: false,
        autosave_pending: false,
        trigger_resolving_ids: [],
        draft_warning: null,
        confirmations: [],
      },
      changes: {
        has_local_changes: false,
        undo_depth: 0,
        redo_depth: 0,
      },
      affordances: {
        can_edit: true,
        can_save: true,
        can_delete_selection: true,
        can_connect: false,
        actions: [
          {
            id: "workflow.create.canvas",
            action_id: "workflow.create",
            scope: "workflow",
            label: "Create workflow draft",
            description: "Create a new draft workflow from the operator context.",
            availability: "available",
            suggested_args: { source: "operator_eval" },
          },
          {
            id: "workflow.update.current",
            action_id: "workflow.update",
            scope: "workflow",
            label: "Update current workflow",
            description: "Persist the current workflow definition.",
            availability: "available",
            suggested_args: { id: "operator-eval-space" },
          },
          {
            id: "trigger.set.selection",
            action_id: "trigger.set",
            scope: "selection",
            label: "Set selected trigger",
            description: "Configure the selected event trigger.",
            availability: "available",
            suggested_args: { workflow_id: "operator-eval-space", id: "start_event" },
          },
        ],
      },
      registries: {
        roles: ["Operator"],
        documents: [],
        adapters: ["telegram"],
      },
    },
  };
}

describe("operator benchmark harness", () => {
  it("materializes a created workflow and exposes observable receipts", async () => {
    const workflowId = `operator-eval-create-${RUN}`;
    const result = await runOperatorBenchmarkScenario({
      id: `tsunade-create-${RUN}`,
      operator: "tsunade",
      message: "Создай новый процесс согласования заказа.",
      operator_state: buildOperatorState("Operator Eval: Create"),
      raw_output: JSON.stringify({
        reply: "Создала черновик процесса согласования заказа.",
        create_workflow: {
          id: workflowId,
          name: "Согласование заказа",
          version: "1.0",
          description: "Черновик для operator eval.",
          elements: [],
          flow: [],
        },
      }),
      autonomy_overrides: {
        "workflow.create": "auto",
      },
    });

    expect(result.state_version).toBe(OPERATOR_STATE_VERSION);
    expect(getPrimaryObservableStatus(result)).toBe("succeeded");
    expect(result.response.created_workflow?.id).toBe(workflowId);
    expect(result.materialized_workflows).toHaveLength(1);
    expect(result.materialized_workflows[0].id).toBe(workflowId);
    expect((result.materialized_workflows[0] as any).status).toBe("draft");
    expect(result.response.action_receipts.some((receipt) => receipt.action === "workflow.create" && receipt.status === "succeeded")).toBe(true);
    expect(result.parsed_event.created_workflow).toEqual(result.response.created_workflow);
    expect(result.audit_entries.some((entry) => entry.action_type === "workflow.create" && entry.result === "ok")).toBe(true);
  });

  it("captures confirm-required workflow creation without materializing side effects", async () => {
    const workflowId = `operator-eval-confirm-${RUN}`;
    const result = await runOperatorBenchmarkScenario({
      id: `tsunade-confirm-${RUN}`,
      operator: "tsunade",
      message: "Создай процесс, но сначала спроси подтверждение.",
      operator_state: buildOperatorState("Operator Eval: Confirm"),
      raw_output: JSON.stringify({
        reply: "Подготовила создание процесса и жду подтверждение.",
        create_workflow: {
          id: workflowId,
          name: "Подтверждаемый процесс",
          version: "1.0",
          elements: [],
          flow: [],
        },
      }),
      autonomy_overrides: {
        "workflow.create": "confirm",
      },
    });

    expect(getPrimaryObservableStatus(result)).toBe("pending_confirmation");
    expect(result.response.created_workflow).toBeNull();
    expect(result.materialized_workflows).toHaveLength(0);
    expect(result.response.pending_confirmations).toHaveLength(1);
    expect(result.response.pending_confirmations[0].action).toBe("workflow.create");
    expect(result.response.action_receipts.some((receipt) => receipt.action === "workflow.create" && receipt.status === "pending_confirmation")).toBe(true);
    expect(result.audit_entries.some((entry) => entry.action_type === "workflow.create" && entry.result === "requires_confirm")).toBe(true);
  });

  it("falls back safely on malformed operator output without materialized changes", async () => {
    const result = await runOperatorBenchmarkScenario({
      id: `tsunade-fallback-${RUN}`,
      operator: "tsunade",
      message: "Попробуй исправить триггер, если уверена.",
      operator_state: buildOperatorState("Operator Eval: Fallback"),
      raw_output: JSON.stringify({
        unexpected_plan: ["inspect", "think", "maybe later"],
        debug: { malformed_contract: true },
      }),
    });

    expect(getPrimaryObservableStatus(result)).toBe("no_effect");
    expect(result.response.reply).toBe("Выполнено.");
    expect(result.response.action_receipts).toHaveLength(0);
    expect(result.materialized_workflows).toHaveLength(0);
    expect(result.audit_entries).toHaveLength(0);
    expect(result.parsed_event.observable_result).toEqual(result.response.observable_result);
  });
});
