import type { HistoryEntry } from "../../src/runtime/cases/types";
import type { WorkflowDefinition } from "../../src/workflow-loader";

export type PlannerFixtureCategory =
  | "branch"
  | "wait"
  | "loop"
  | "terminal"
  | "malformed";

export interface PlannerTransitionFixture {
  id: string;
  category: PlannerFixtureCategory;
  workflow: WorkflowDefinition;
  position: string;
  payload?: Record<string, unknown>;
  history?: Omit<HistoryEntry, "timestamp">[];
  expected: {
    kind: string;
    position?: string;
    forced_next_id?: string;
    effect_kinds: string[];
  };
}

export interface JoinTransitionFixture {
  id: string;
  workflow: WorkflowDefinition;
  branch_ids: string[];
  expected: {
    kind: "gateway_join" | "error";
    position: string;
  };
}

function workflow(
  id: string,
  elements: WorkflowDefinition["elements"],
  flow: WorkflowDefinition["flow"],
): WorkflowDefinition {
  return {
    id: `state-machine-transition-fixture:${id}`,
    version: "1.0.0",
    name: `State machine transition fixture: ${id}`,
    elements,
    flow,
  };
}

export const PLANNER_TRANSITION_FIXTURES: PlannerTransitionFixture[] = [
  {
    id: "xor-branch-selects-first-matching-path",
    category: "branch",
    workflow: workflow(
      "xor-branch",
      [
        { id: "route", type: "gateway", label: "Route", operator: "XOR" },
        { id: "path_a", type: "function", label: "Path A", role: "qa" },
        { id: "path_b", type: "function", label: "Path B", role: "qa" },
      ],
      [
        ["route", "path_a", "payload.path === 'a'"],
        ["route", "path_b", "payload.path === 'b'"],
      ],
    ),
    position: "route",
    payload: { path: "b" },
    expected: {
      kind: "continue",
      position: "route",
      forced_next_id: "path_b",
      effect_kinds: ["gateway.evaluated"],
    },
  },
  {
    id: "and-split-plans-function-branches",
    category: "branch",
    workflow: workflow(
      "and-split",
      [
        { id: "split", type: "gateway", label: "Split", operator: "AND" },
        { id: "a_ready", type: "event", label: "A Ready" },
        { id: "b_ready", type: "event", label: "B Ready" },
        { id: "task_a", type: "function", label: "Task A", role: "qa" },
        { id: "task_b", type: "function", label: "Task B", role: "qa" },
        { id: "join", type: "gateway", label: "Join", operator: "AND" },
      ],
      [
        ["split", "a_ready"],
        ["split", "b_ready"],
        ["a_ready", "task_a"],
        ["b_ready", "task_b"],
        ["task_a", "join"],
        ["task_b", "join"],
      ],
    ),
    position: "split",
    expected: {
      kind: "gateway_split",
      position: "split",
      effect_kinds: ["gateway.evaluated"],
    },
  },
  {
    id: "or-split-selects-all-matching-branches",
    category: "branch",
    workflow: workflow(
      "or-split",
      [
        { id: "split", type: "gateway", label: "Split", operator: "OR" },
        { id: "task_a", type: "function", label: "Task A", role: "qa" },
        { id: "task_b", type: "function", label: "Task B", role: "qa" },
        { id: "join", type: "gateway", label: "Join", operator: "OR" },
      ],
      [
        ["split", "task_a", "payload.a === true"],
        ["split", "task_b", "payload.b === true"],
        ["task_a", "join"],
        ["task_b", "join"],
      ],
    ),
    position: "split",
    payload: { a: true, b: true },
    expected: {
      kind: "gateway_split",
      position: "split",
      effect_kinds: ["gateway.evaluated"],
    },
  },
  {
    id: "manual-intermediate-event-pauses-as-wait",
    category: "wait",
    workflow: workflow(
      "manual-wait",
      [
        { id: "review", type: "function", label: "Review", role: "qa" },
        { id: "approval", type: "event", label: "Approval", trigger: { kind: "manual", deadline: "2099-01-01T00:00:00.000Z" } },
        { id: "publish", type: "function", label: "Publish", role: "qa" },
      ],
      [["review", "approval"], ["approval", "publish"]],
    ),
    position: "review",
    expected: {
      kind: "event_wait",
      position: "approval",
      effect_kinds: ["event.wait"],
    },
  },
  {
    id: "message-intermediate-event-pauses-with-subscribe-intent",
    category: "wait",
    workflow: workflow(
      "message-wait",
      [
        { id: "ask", type: "function", label: "Ask", role: "qa" },
        { id: "reply", type: "event", label: "Reply", trigger: { kind: "message", source: "telegram", filter: { chat: "ops" } } },
        { id: "record", type: "function", label: "Record", role: "qa" },
      ],
      [["ask", "reply"], ["reply", "record"]],
    ),
    position: "ask",
    expected: {
      kind: "event_wait",
      position: "reply",
      effect_kinds: ["event.wait"],
    },
  },
  {
    id: "bounded-loop-revisits-same-gateway",
    category: "loop",
    workflow: workflow(
      "bounded-loop",
      [
        { id: "start", type: "event", label: "Start" },
        { id: "route", type: "gateway", label: "Route", operator: "XOR" },
        { id: "tick", type: "event", label: "Tick" },
      ],
      [
        ["start", "route"],
        ["route", "tick", "payload.repeat === true"],
        ["tick", "route"],
      ],
    ),
    position: "start",
    payload: { repeat: true },
    expected: {
      kind: "continue",
      position: "route",
      forced_next_id: "tick",
      effect_kinds: ["gateway.evaluated"],
    },
  },
  {
    id: "terminal-event-completes-without-duplicating-history",
    category: "terminal",
    workflow: workflow(
      "terminal-event",
      [{ id: "done", type: "event", label: "Done" }],
      [],
    ),
    position: "done",
    history: [{ element_id: "done", element_type: "event", label: "Done" }],
    expected: {
      kind: "complete",
      position: "done",
      effect_kinds: ["case.complete"],
    },
  },
  {
    id: "missing-target-fails-closed",
    category: "malformed",
    workflow: workflow(
      "missing-target",
      [{ id: "start", type: "event", label: "Start" }],
      [["start", "missing"]],
    ),
    position: "start",
    expected: {
      kind: "error",
      position: "missing",
      effect_kinds: ["case.error"],
    },
  },
  {
    id: "non-event-terminal-fails-closed",
    category: "malformed",
    workflow: workflow(
      "non-event-terminal",
      [{ id: "task", type: "function", label: "Task", role: "qa" }],
      [],
    ),
    position: "task",
    expected: {
      kind: "error",
      position: "task",
      effect_kinds: ["case.error"],
    },
  },
];

export const JOIN_TRANSITION_FIXTURES: JoinTransitionFixture[] = [
  {
    id: "and-branches-join-at-common-gateway",
    workflow: workflow(
      "and-join",
      [
        { id: "task_a", type: "function", label: "Task A", role: "qa" },
        { id: "task_b", type: "function", label: "Task B", role: "qa" },
        { id: "join", type: "gateway", label: "Join", operator: "AND" },
        { id: "done", type: "event", label: "Done" },
      ],
      [
        ["task_a", "join"],
        ["task_b", "join"],
        ["join", "done"],
      ],
    ),
    branch_ids: ["task_a", "task_b"],
    expected: {
      kind: "gateway_join",
      position: "join",
    },
  },
  {
    id: "divergent-branches-fail-closed-without-common-join",
    workflow: workflow(
      "missing-join",
      [
        { id: "task_a", type: "function", label: "Task A", role: "qa" },
        { id: "task_b", type: "function", label: "Task B", role: "qa" },
        { id: "done_a", type: "event", label: "Done A" },
        { id: "done_b", type: "event", label: "Done B" },
      ],
      [
        ["task_a", "done_a"],
        ["task_b", "done_b"],
      ],
    ),
    branch_ids: ["task_a", "task_b"],
    expected: {
      kind: "error",
      position: "(join)",
    },
  },
];
