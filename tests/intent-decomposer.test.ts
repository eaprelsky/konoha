/**
 * intent-decomposer.test.ts
 *
 * Tests for issue #503: high-level intent → action sequence decomposition.
 */

import { describe, it, expect } from "bun:test";
import { decomposeIntent, listIntents, getIntent } from "../src/intent-decomposer";

describe("listIntents / getIntent", () => {
  it("lists all registered intents", () => {
    const intents = listIntents();
    expect(intents.length).toBeGreaterThanOrEqual(6);
    expect(intents.map(i => i.id)).toContain("add_approval_step");
    expect(intents.map(i => i.id)).toContain("confirm_manual_event");
  });

  it("gets a specific intent by id", () => {
    const intent = getIntent("add_timer_start");
    expect(intent).toBeDefined();
    expect(intent!.params).toContain("cron");
  });

  it("returns undefined for unknown intent", () => {
    expect(getIntent("nonexistent_intent")).toBeUndefined();
  });
});

describe("decomposeIntent — unknown intent", () => {
  it("returns null for unknown intent id", () => {
    expect(decomposeIntent("does_not_exist", {})).toBeNull();
  });
});

describe("decomposeIntent — missing params", () => {
  it("returns empty actions with side_effect for missing param", () => {
    const plan = decomposeIntent("add_approval_step", { workflow_id: "wf1" });
    expect(plan).not.toBeNull();
    expect(plan!.actions).toHaveLength(0);
    expect(plan!.side_effects[0]).toContain("Missing required parameter");
  });
});

describe("decomposeIntent — add_approval_step", () => {
  const params = {
    workflow_id: "wf_001",
    after_element: "func_review",
    label: "Согласование",
    role: "manager",
  };

  it("produces 2 ordered actions", () => {
    const plan = decomposeIntent("add_approval_step", params);
    expect(plan).not.toBeNull();
    expect(plan!.intent).toBe("add_approval_step");
    expect(plan!.actions).toHaveLength(2);
    expect(plan!.actions[0].order).toBe(0);
    expect(plan!.actions[1].order).toBe(1);
  });

  it("first action is element.add with type=event", () => {
    const plan = decomposeIntent("add_approval_step", params);
    const env = plan!.actions[0].envelope;
    expect(env.action).toBe("element.add");
    expect(env.args.type).toBe("event");
    expect(env.args.label).toBe("Согласование");
    expect(env.args.trigger.kind).toBe("manual");
  });

  it("second action is flow.add connecting after_element to new event", () => {
    const plan = decomposeIntent("add_approval_step", params);
    const env = plan!.actions[1].envelope;
    expect(env.action).toBe("flow.add");
    expect(env.args.from).toBe("func_review");
    // 'to' should be the generated element id from first action
    expect(env.args.to).toBe(plan!.actions[0].envelope.args.id);
  });

  it("lists meaningful side effects", () => {
    const plan = decomposeIntent("add_approval_step", params);
    expect(plan!.side_effects.length).toBeGreaterThanOrEqual(2);
  });
});

describe("decomposeIntent — add_timer_start", () => {
  const params = {
    workflow_id: "wf_timer",
    cron: "0 9 * * 1",
    label: "Каждый понедельник",
  };

  it("produces 2 actions: element.add + trigger.set", () => {
    const plan = decomposeIntent("add_timer_start", params);
    expect(plan!.actions).toHaveLength(2);
    expect(plan!.actions[0].envelope.action).toBe("element.add");
    expect(plan!.actions[1].envelope.action).toBe("trigger.set");
    expect(plan!.actions[1].envelope.args.kind).toBe("timer");
  });
});

describe("decomposeIntent — add_condition_branch", () => {
  const params = {
    workflow_id: "wf_branch",
    after_element: "func_input",
    condition: "amount > 10000",
    true_label: "Большой заказ",
    false_label: "Малый заказ",
  };

  it("produces 6 ordered actions", () => {
    const plan = decomposeIntent("add_condition_branch", params);
    expect(plan!.actions).toHaveLength(6);
    expect(plan!.actions[0].envelope.action).toBe("element.add");
    expect(plan!.actions[0].envelope.args.type).toBe("gateway");
  });

  it("gateway is XOR operator", () => {
    const plan = decomposeIntent("add_condition_branch", params);
    expect(plan!.actions[0].envelope.args.operator).toBe("XOR");
  });

  it("true branch flow has condition", () => {
    const plan = decomposeIntent("add_condition_branch", params);
    const trueFlow = plan!.actions[4].envelope;
    expect(trueFlow.action).toBe("flow.add");
    expect(trueFlow.args.condition).toBe("amount > 10000");
  });
});

describe("decomposeIntent — confirm_manual_event", () => {
  const params = {
    case_id: "case_123",
    element_id: "evt_approval",
    comment: "Approved by manager",
    confirmed_by: "user_42",
    outcome: "approved",
  };

  it("produces 1 action: event.confirm", () => {
    const plan = decomposeIntent("confirm_manual_event", params);
    expect(plan!.actions).toHaveLength(1);
    expect(plan!.actions[0].envelope.action).toBe("event.confirm");
    expect(plan!.actions[0].envelope.args.case_id).toBe("case_123");
    expect(plan!.actions[0].envelope.args.outcome).toBe("approved");
  });

  it("lists audit side effects", () => {
    const plan = decomposeIntent("confirm_manual_event", params);
    expect(plan!.side_effects).toContain("Audit event 'event.confirmed' will be emitted");
  });
});

describe("decomposeIntent — replace_event_trigger", () => {
  const params = {
    workflow_id: "wf_rep",
    element_id: "evt_old",
    kind: "webhook",
    config: { path: "/hooks/new", method: "POST" },
  };

  it("produces 2 actions: element.update + trigger.set", () => {
    const plan = decomposeIntent("replace_event_trigger", params);
    expect(plan!.actions).toHaveLength(2);
    expect(plan!.actions[0].envelope.action).toBe("element.update");
    expect(plan!.actions[1].envelope.action).toBe("trigger.set");
  });
});

describe("decomposeIntent — add_subprocess", () => {
  const params = {
    workflow_id: "wf_parent",
    after_element: "func_prep",
    label: "Вызов проверки",
    sub_process_id: "proc_check",
  };

  it("produces 2 actions: element.add + flow.add", () => {
    const plan = decomposeIntent("add_subprocess", params);
    expect(plan!.actions).toHaveLength(2);
    expect(plan!.actions[0].envelope.args.sub_process_id).toBe("proc_check");
    expect(plan!.actions[1].envelope.args.from).toBe("func_prep");
  });
});
