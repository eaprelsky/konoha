import { describe, expect, test } from "bun:test";
import type { Case, HistoryEntry } from "../src/runtime/cases/types";
import {
  buildGraphAdjacency,
  planGraphJoinTransition,
  planGraphTransition,
  type GraphTransitionPlan,
} from "../src/runtime/cases/transition-planner";
import { makeCase } from "./factories";
import {
  JOIN_TRANSITION_FIXTURES,
  PLANNER_TRANSITION_FIXTURES,
  type PlannerTransitionFixture,
} from "./fixtures/state-machine-transition-fixtures";

type PlannedHistory = Omit<HistoryEntry, "timestamp">[];

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function caseForFixture(fixture: PlannerTransitionFixture): Case {
  return makeCase({
    process_id: fixture.workflow.id,
    position: fixture.position,
    payload: cloneJson(fixture.payload ?? {}),
    history: cloneJson(fixture.history ?? []),
  });
}

function effectKinds(plan: GraphTransitionPlan): string[] {
  return plan.effects.map(effect => effect.kind);
}

function planPosition(plan: GraphTransitionPlan): string | undefined {
  return "position" in plan ? plan.position : undefined;
}

function appendHistory(history: PlannedHistory, entries: PlannedHistory): PlannedHistory {
  return [...history, ...entries.map(entry => ({ ...entry }))];
}

function runPureContinueSteps(
  fixture: PlannerTransitionFixture,
  maxSteps: number,
): Array<{ current: string; forced_next_id: string | null; plan: GraphTransitionPlan }> {
  const states: Array<{ current: string; forced_next_id: string | null; plan: GraphTransitionPlan }> = [];
  let current = fixture.position;
  let forcedNextId: string | null = null;
  let history: PlannedHistory = cloneJson(fixture.history ?? []);

  for (let step = 0; step < maxSteps; step++) {
    const kase = makeCase({
      process_id: fixture.workflow.id,
      position: current,
      payload: cloneJson(fixture.payload ?? {}),
      history: cloneJson(history),
    });
    const plan = planGraphTransition({
      workflow: fixture.workflow,
      case: kase,
      current,
      forced_next_id: forcedNextId,
    });
    states.push({ current, forced_next_id: forcedNextId, plan });

    if (plan.kind !== "continue") break;
    current = plan.next_current;
    forcedNextId = plan.forced_next_id ?? null;
    history = appendHistory(history, plan.history);
  }

  return states;
}

describe("state-machine transition property fixtures", () => {
  for (const fixture of PLANNER_TRANSITION_FIXTURES) {
    test(`${fixture.id} satisfies pure planner invariants`, () => {
      const workflowBefore = cloneJson(fixture.workflow);
      const kase = caseForFixture(fixture);
      const caseBefore = cloneJson(kase);

      const plan = planGraphTransition({ workflow: fixture.workflow, case: kase });

      expect(plan.kind).toBe(fixture.expected.kind);
      expect(planPosition(plan)).toBe(fixture.expected.position);
      expect(effectKinds(plan)).toEqual(fixture.expected.effect_kinds);
      if (plan.kind === "continue") {
        expect(plan.forced_next_id).toBe(fixture.expected.forced_next_id);
      }

      expect(kase).toEqual(caseBefore);
      expect(fixture.workflow).toEqual(workflowBefore);
    });
  }

  test("branch fixtures expose deterministic branch work-item intents", () => {
    const branchPlans = PLANNER_TRANSITION_FIXTURES
      .filter(fixture => fixture.category === "branch")
      .map(fixture => planGraphTransition({ workflow: fixture.workflow, case: caseForFixture(fixture) }));

    for (const plan of branchPlans) {
      if (plan.kind !== "gateway_split") continue;
      expect(new Set(plan.active_branch_ids).size).toBe(plan.active_branch_ids.length);
      expect(plan.branch_work_items.length).toBeGreaterThan(0);
      for (const branch of plan.branch_work_items) {
        expect(branch.element.type).toBe("function");
        expect(plan.active_branch_ids).toContain(branch.branch_start_id);
        expect(branch.skipped_history.every(entry => entry.element_type === "event")).toBe(true);
      }
    }
  });

  test("wait fixtures encode wait side-effect intent without executing runtime work", () => {
    const waitPlans = PLANNER_TRANSITION_FIXTURES
      .filter(fixture => fixture.category === "wait")
      .map(fixture => ({ fixture, plan: planGraphTransition({ workflow: fixture.workflow, case: caseForFixture(fixture) }) }));

    expect(waitPlans).toHaveLength(2);
    for (const { fixture, plan } of waitPlans) {
      expect(plan.kind).toBe("event_wait");
      if (plan.kind !== "event_wait") continue;
      expect(plan.effects).toHaveLength(1);
      expect(plan.effects[0]).toMatchObject({ kind: "event.wait", element_id: plan.element_id });
      if (fixture.id.includes("manual")) {
        expect(plan.subscribe).toBe(false);
        expect(plan.schedule_reminders).toBe(true);
      } else {
        expect(plan.subscribe).toBe(true);
        expect(plan.schedule_reminders).toBe(false);
      }
    }
  });

  test("loop fixture is bounded and revisits a known planner state without side effects", () => {
    const fixture = PLANNER_TRANSITION_FIXTURES.find(item => item.category === "loop");
    if (!fixture) throw new Error("missing loop fixture");

    const states = runPureContinueSteps(fixture, 6);
    const stateKeys = states.map(state => `${state.current}:${state.forced_next_id ?? ""}`);

    expect(states.every(state => state.plan.kind === "continue")).toBe(true);
    expect(new Set(stateKeys).size).toBeLessThan(stateKeys.length);
    expect(states.flatMap(state => state.plan.effects).every(effect => effect.kind === "gateway.evaluated")).toBe(true);
  });

  test("terminal fixture completes without duplicating already-recorded terminal history", () => {
    const fixture = PLANNER_TRANSITION_FIXTURES.find(item => item.category === "terminal");
    if (!fixture) throw new Error("missing terminal fixture");

    const plan = planGraphTransition({ workflow: fixture.workflow, case: caseForFixture(fixture) });

    expect(plan.kind).toBe("complete");
    expect(plan.kind === "complete" ? plan.history : []).toEqual([]);
    expect(effectKinds(plan)).toEqual(["case.complete"]);
  });

  test("malformed graph fixtures fail closed with machine-readable error intent", () => {
    const malformedPlans = PLANNER_TRANSITION_FIXTURES
      .filter(fixture => fixture.category === "malformed")
      .map(fixture => planGraphTransition({ workflow: fixture.workflow, case: caseForFixture(fixture) }));

    expect(malformedPlans.length).toBeGreaterThanOrEqual(2);
    for (const plan of malformedPlans) {
      expect(plan.kind).toBe("error");
      expect(effectKinds(plan)).toEqual(["case.error"]);
      expect(plan.kind === "error" ? plan.reason.length : 0).toBeGreaterThan(0);
    }
  });

  for (const fixture of JOIN_TRANSITION_FIXTURES) {
    test(`${fixture.id} satisfies pure join-planner invariants`, () => {
      const workflowBefore = cloneJson(fixture.workflow);
      const adjacency = buildGraphAdjacency(fixture.workflow);

      const plan = planGraphJoinTransition(fixture.branch_ids, adjacency);

      expect(plan.kind).toBe(fixture.expected.kind);
      expect(plan.position).toBe(fixture.expected.position);
      expect(plan.history).toHaveLength(1);
      expect(fixture.workflow).toEqual(workflowBefore);
    });
  }
});
