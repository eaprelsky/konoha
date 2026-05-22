import { describe, expect, test } from "bun:test";
import { makeCase, makeWorkflowDefinition } from "./factories";
import { buildGraphAdjacency, planGraphJoinTransition, planGraphTransition } from "../src/runtime/cases/transition-planner";

describe("pure graph transition planner", () => {
  test("selects a deterministic XOR branch without mutating the case", () => {
    const workflow = makeWorkflowDefinition({
      elements: [
        { id: "start", type: "event", label: "Start" },
        { id: "route", type: "gateway", label: "Route", operator: "XOR" },
        { id: "path_a", type: "function", label: "Path A", role: "qa" },
        { id: "path_b", type: "function", label: "Path B", role: "qa" },
      ],
      flow: [
        ["start", "route"],
        ["route", "path_a", "payload.path === 'a'"],
        ["route", "path_b", "payload.path === 'b'"],
      ],
    });
    const kase = makeCase({ position: "route", payload: { path: "b" }, history: [] });

    const plan = planGraphTransition({ workflow, case: kase });

    expect(plan).toMatchObject({
      kind: "continue",
      position: "route",
      next_current: "route",
      forced_next_id: "path_b",
      history: [{ element_id: "route", element_type: "gateway", label: "Route" }],
      effects: [{ kind: "gateway.evaluated", element_id: "route", label: "Route" }],
    });
    expect(kase.position).toBe("route");
    expect(kase.history).toEqual([]);
  });

  test("returns branch work-item intents for AND split while skipping event-only branch starts", () => {
    const workflow = makeWorkflowDefinition({
      elements: [
        { id: "start", type: "event", label: "Start" },
        { id: "split", type: "gateway", label: "Split", operator: "AND" },
        { id: "event_a", type: "event", label: "A ready" },
        { id: "event_b", type: "event", label: "B ready" },
        { id: "task_a", type: "function", label: "Task A", role: "qa" },
        { id: "task_b", type: "function", label: "Task B", role: "qa" },
      ],
      flow: [
        ["start", "split"],
        ["split", "event_a"],
        ["split", "event_b"],
        ["event_a", "task_a"],
        ["event_b", "task_b"],
      ],
    });

    const plan = planGraphTransition({ workflow, case: makeCase({ position: "split" }) });

    expect(plan).toMatchObject({
      kind: "gateway_split",
      position: "split",
      active_branch_ids: ["event_a", "event_b"],
      split_history: { element_id: "split", element_type: "gateway", label: "AND split (2 branches)" },
      effects: [{ kind: "gateway.evaluated", element_id: "split", label: "Split" }],
    });
    expect(plan.kind === "gateway_split" ? plan.branch_work_items.map(item => ({
      branch_start_id: item.branch_start_id,
      element_id: item.element_id,
      skipped_history: item.skipped_history,
    })) : []).toEqual([
      { branch_start_id: "event_a", element_id: "task_a", skipped_history: [{ element_id: "event_a", element_type: "event", label: "A ready" }] },
      { branch_start_id: "event_b", element_id: "task_b", skipped_history: [{ element_id: "event_b", element_type: "event", label: "B ready" }] },
    ]);
  });

  test("plans branch join resolution through the same pure graph contract", () => {
    const workflow = makeWorkflowDefinition({
      elements: [
        { id: "split", type: "gateway", label: "Split", operator: "AND" },
        { id: "task_a", type: "function", label: "Task A", role: "qa" },
        { id: "task_b", type: "function", label: "Task B", role: "qa" },
        { id: "join", type: "gateway", label: "Join", operator: "AND" },
        { id: "done", type: "event", label: "Done" },
      ],
      flow: [
        ["split", "task_a"],
        ["split", "task_b"],
        ["task_a", "join"],
        ["task_b", "join"],
        ["join", "done"],
      ],
    });

    const plan = planGraphJoinTransition(["task_a", "task_b"], buildGraphAdjacency(workflow));

    expect(plan).toEqual({
      kind: "gateway_join",
      position: "join",
      history: [{ element_id: "join", element_type: "gateway", label: "join" }],
      effects: [],
    });
  });

  test("plans join gateways as pass-through transitions instead of split work", () => {
    const workflow = makeWorkflowDefinition({
      elements: [
        { id: "task_a", type: "function", label: "Task A", role: "qa" },
        { id: "task_b", type: "function", label: "Task B", role: "qa" },
        { id: "join", type: "gateway", label: "Join", operator: "AND" },
        { id: "done", type: "event", label: "Done" },
      ],
      flow: [
        ["task_a", "join"],
        ["task_b", "join"],
        ["join", "done"],
      ],
    });

    const plan = planGraphTransition({ workflow, case: makeCase({ position: "join" }) });

    expect(plan).toMatchObject({
      kind: "continue",
      position: "join",
      forced_next_id: "done",
      history: [{ element_id: "join", element_type: "gateway", label: "Join" }],
      effects: [{ kind: "gateway.evaluated", element_id: "join", label: "Join" }],
    });
  });

  test("returns event wait intents without creating waits, reminders, or subscriptions", () => {
    const workflow = makeWorkflowDefinition({
      elements: [
        { id: "start", type: "event", label: "Start" },
        { id: "review", type: "function", label: "Review", role: "qa" },
        { id: "approved", type: "event", label: "Approved", role: "manager", trigger: { kind: "manual", deadline: "2099-01-01T00:00:00.000Z" } },
        { id: "publish", type: "function", label: "Publish", role: "qa" },
      ],
      flow: [["start", "review"], ["review", "approved"], ["approved", "publish"]],
    });

    const plan = planGraphTransition({ workflow, case: makeCase({ position: "review" }) });

    expect(plan).toMatchObject({
      kind: "event_wait",
      position: "approved",
      element_id: "approved",
      trigger_kind: "manual",
      subscribe: false,
      schedule_reminders: true,
      history: [{ element_id: "approved", element_type: "event", label: "Approved" }],
      effects: [{
        kind: "event.wait",
        element_id: "approved",
        label: "Approved",
        trigger_kind: "manual",
        subscribe: false,
        schedule_reminders: true,
      }],
    });
  });

  test("returns terminal completion as state change intent without side effects", () => {
    const workflow = makeWorkflowDefinition({
      elements: [{ id: "end", type: "event", label: "Done" }],
      flow: [],
    });
    const kase = makeCase({ position: "end", history: [] });

    const plan = planGraphTransition({ workflow, case: kase });

    expect(plan).toMatchObject({
      kind: "complete",
      position: "end",
      history: [{ element_id: "end", element_type: "event", label: "Done" }],
      effects: [{ kind: "case.complete", element_id: "end" }],
    });
    expect(kase.status).toBe("running");
  });

  test("returns a closed error intent when an XOR gateway has no matching branch", () => {
    const workflow = makeWorkflowDefinition({
      elements: [
        { id: "route", type: "gateway", label: "Route", operator: "XOR" },
        { id: "path_a", type: "function", label: "Path A", role: "qa" },
      ],
      flow: [["route", "path_a", "payload.path === 'a'"]],
    });
    const kase = makeCase({ position: "route", payload: { path: "b" }, history: [] });

    const plan = planGraphTransition({ workflow, case: kase });

    expect(plan).toMatchObject({
      kind: "error",
      position: "route",
      reason: "gateway route condition did not match",
      history: [{ element_id: "route", element_type: "gateway", label: "Route" }],
      effects: [
        { kind: "gateway.evaluated", element_id: "route", label: "Route" },
        { kind: "case.error", element_id: "route", reason: "gateway route condition did not match" },
      ],
    });
    expect(kase.history).toEqual([]);
  });
});
