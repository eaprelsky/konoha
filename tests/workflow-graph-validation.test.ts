import { describe, expect, test } from "bun:test";
import { validateWorkflow, validateWorkflowReadiness, type WorkflowDefinition } from "../src/workflow-loader";
import { makeWorkflowDefinition } from "./factories";

function graph(elements: WorkflowDefinition["elements"], flow: WorkflowDefinition["flow"]): WorkflowDefinition {
  return makeWorkflowDefinition({ elements, flow });
}

describe("workflow graph validation", () => {
  test("rejects malformed edge shapes without message parsing", () => {
    const errors = validateWorkflow(makeWorkflowDefinition({
      flow: [["event_start", 42] as any],
    }));

    expect(errors).toContainEqual(expect.objectContaining({
      code: "GRAPH_INVALID_EDGE_SHAPE",
      class: "graph",
    }));
  });

  test("rejects duplicate element ids", () => {
    const receipt = validateWorkflowReadiness(graph(
      [
        { id: "start", type: "event", label: "Start" },
        { id: "task", type: "function", label: "Task", role: "Operator" },
        { id: "task", type: "function", label: "Duplicate task", role: "Operator" },
        { id: "done", type: "event", label: "Done" },
      ],
      [["start", "task"], ["task", "done"]],
    ));

    expect(receipt.errors).toContainEqual(expect.objectContaining({
      code: "GRAPH_DUPLICATE_ELEMENT_ID",
      class: "graph",
      element_id: "task",
    }));
  });

  test("blocks unreachable nodes and reachable nodes without terminal paths", () => {
    const receipt = validateWorkflowReadiness(graph(
      [
        { id: "start", type: "event", label: "Start" },
        { id: "task", type: "function", label: "Task", role: "Operator" },
        { id: "loop", type: "event", label: "Loop" },
        { id: "orphan_task", type: "function", label: "Orphan task", role: "Operator" },
        { id: "orphan_done", type: "event", label: "Orphan done" },
      ],
      [["start", "task"], ["task", "loop"], ["loop", "task"], ["orphan_task", "orphan_done"]],
    ));

    expect(receipt.errors).toContainEqual(expect.objectContaining({
      code: "GRAPH_UNREACHABLE_ELEMENT",
      class: "graph",
      element_id: "orphan_task",
    }));
    expect(receipt.errors).toContainEqual(expect.objectContaining({
      code: "GRAPH_NO_TERMINAL_PATH",
      class: "graph",
      element_id: "start",
    }));
  });

  test("rejects non-event terminal states", () => {
    const receipt = validateWorkflowReadiness(graph(
      [
        { id: "start", type: "event", label: "Start" },
        { id: "task", type: "function", label: "Task", role: "Operator" },
      ],
      [["start", "task"]],
    ));

    expect(receipt.errors).toContainEqual(expect.objectContaining({
      code: "GRAPH_INVALID_TERMINAL_STATE",
      legacy_code: "GRAPH_NO_TERMINAL_EVENT",
      class: "graph",
    }));
  });

  test("rejects pass-through cycles without a function boundary", () => {
    const receipt = validateWorkflowReadiness(graph(
      [
        { id: "start", type: "event", label: "Start" },
        { id: "gate", type: "gateway", label: "Gate", operator: "XOR" },
        { id: "again", type: "event", label: "Again" },
        { id: "done", type: "event", label: "Done" },
      ],
      [["start", "gate"], ["gate", "again"], ["again", "gate"]],
    ));

    expect(receipt.errors).toContainEqual(expect.objectContaining({
      code: "GRAPH_UNSUPPORTED_CYCLE",
      class: "graph",
      details: { nodes: ["again", "gate"] },
    }));
  });

  test("rejects ambiguous unconditioned terminal branches", () => {
    const receipt = validateWorkflowReadiness(graph(
      [
        { id: "start", type: "event", label: "Start" },
        { id: "prep", type: "function", label: "Prepare", role: "Operator" },
        { id: "split", type: "gateway", label: "Split", operator: "XOR" },
        { id: "path_a", type: "event", label: "Path A" },
        { id: "task_a", type: "function", label: "Task A", role: "Operator" },
        { id: "done_a", type: "event", label: "Done A" },
        { id: "path_b", type: "event", label: "Path B" },
        { id: "task_b", type: "function", label: "Task B", role: "Operator" },
        { id: "done_b", type: "event", label: "Done B" },
      ],
      [
        ["start", "prep"],
        ["prep", "split"],
        ["split", "path_a"],
        ["path_a", "task_a"],
        ["task_a", "done_a"],
        ["split", "path_b"],
        ["path_b", "task_b"],
        ["task_b", "done_b"],
      ],
    ));

    expect(receipt.errors).toContainEqual(expect.objectContaining({
      code: "GRAPH_AMBIGUOUS_TERMINAL_BRANCH",
      class: "graph",
      element_id: "split",
    }));
  });

  test("allows rework cycles that have a function boundary and terminal exit", () => {
    const receipt = validateWorkflowReadiness(graph(
      [
        { id: "start", type: "event", label: "Start" },
        { id: "review", type: "function", label: "Review", role: "Operator" },
        { id: "decide", type: "gateway", label: "Decide", operator: "XOR" },
        { id: "rework", type: "event", label: "Rework needed" },
        { id: "done", type: "event", label: "Done" },
      ],
      [
        ["start", "review"],
        ["review", "decide"],
        ["decide", "rework", "payload.approved === false"],
        ["rework", "review"],
        ["decide", "done", "payload.approved === true"],
      ],
    ));

    expect(receipt.errors.map(error => error.code)).not.toContain("GRAPH_UNSUPPORTED_CYCLE");
    expect(receipt.errors.map(error => error.code)).not.toContain("GRAPH_NO_TERMINAL_PATH");
  });
});
