import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { validateWorkflow, type WorkflowDefinition } from "../src/workflow-loader";
import { makeWorkflowDefinition } from "./factories";

describe("workflow-loader validation", () => {
  test("accepts a minimal valid eEPC workflow", () => {
    const def = makeWorkflowDefinition();
    expect(validateWorkflow(def)).toEqual([]);
  });

  test("rejects processes that do not start with an event", () => {
    const def: WorkflowDefinition = makeWorkflowDefinition({
      elements: [
        { id: "fn_1", type: "function", label: "Review request", role: "Operator" },
        { id: "event_end", type: "event", label: "Done" },
      ],
      flow: [["fn_1", "event_end"]],
    });

    const errors = validateWorkflow(def);
    expect(errors.some((error) => error.rule === 1 && error.message.includes("Process must start with an event"))).toBe(true);
  });

  test("rejects direct event to event transitions", () => {
    const def: WorkflowDefinition = makeWorkflowDefinition({
      elements: [
        { id: "event_start", type: "event", label: "Order received" },
        { id: "event_end", type: "event", label: "Order closed" },
      ],
      flow: [["event_start", "event_end"]],
    });

    const errors = validateWorkflow(def);
    expect(errors.some((error) => error.rule === 2 && error.message.includes("directly connected to event"))).toBe(true);
  });

  test("rejects non-function elements that carry roles or systems", () => {
    const def: WorkflowDefinition = makeWorkflowDefinition({
      elements: [
        { id: "event_start", type: "event", label: "Order received", role: "Operator", system: "telegram" },
        { id: "fn_1", type: "function", label: "Review request", role: "Operator" },
        { id: "event_end", type: "event", label: "Order closed" },
      ],
    });

    const errors = validateWorkflow(def);
    expect(errors.some((error) => error.rule === 3 && error.message.includes("roles must only be attached to functions"))).toBe(true);
    expect(errors.some((error) => error.rule === 3 && error.message.includes("systems must only be attached to functions"))).toBe(true);
  });

  test("rejects functions without a role", () => {
    const def: WorkflowDefinition = makeWorkflowDefinition({
      elements: [
        { id: "event_start", type: "event", label: "Order received" },
        { id: "fn_1", type: "function", label: "Review request" },
        { id: "event_end", type: "event", label: "Order closed" },
      ],
    });

    const errors = validateWorkflow(def);
    expect(errors.some((error) => error.rule === 5 && error.message.includes("has no role assigned"))).toBe(true);
  });
});

describe("workflow-loader e2e: lead-qualification", () => {
  const workflowPath = join(import.meta.dir, "..", "workflows", "sales", "lead-qualification.json");
  let def: WorkflowDefinition;

  test("loads and validates lead-qualification workflow from disk", () => {
    const raw = readFileSync(workflowPath, "utf-8");
    def = JSON.parse(raw);
    expect(def.id).toBe("lead-qualification");
    expect(def.elements.length).toBeGreaterThanOrEqual(5);
    expect(def.flow.length).toBeGreaterThanOrEqual(4);
    const errors = validateWorkflow(def);
    expect(errors).toEqual([]);
  });

  test("has Telegram lead start event e1", () => {
    const e1 = def.elements.find(el => el.id === "e1");
    expect(e1).toBeDefined();
    expect(e1!.type).toBe("event");
    expect(e1!.trigger?.kind).toBe("message");
    expect(e1!.trigger?.source).toBe("telegram");
  });

  test("models Sasuke triage followed by human sales owner tasks", () => {
    const stages = def.elements
      .filter(el => el.type === "function")
      .map(el => ({ id: el.id, label: el.label, role: el.role }));
    expect(stages).toEqual([
      { id: "f1", label: "Triage lead signal", role: "sasuke" },
      { id: "f2", label: "Review lead and decide next step", role: "sales_owner" },
      { id: "f3", label: "Prepare content proposal", role: "sales_owner" },
      { id: "f4", label: "Prepare estimate request", role: "sales_owner" },
      { id: "f5", label: "Assemble commercial proposal and follow-up", role: "sales_owner" },
    ]);
  });

  test("has one terminal event for the prepared follow-up", () => {
    const eventIdsWithOutgoing = new Set(def.flow.map(([from]) => from));
    const terminals = def.elements.filter(el => el.type === "event" && !eventIdsWithOutgoing.has(el.id));
    expect(terminals.map(el => el.id)).toEqual(["e6"]);
  });

  test("flow edges reference valid element IDs", () => {
    const validIds = new Set(def.elements.map(el => el.id));
    for (const [from, to] of def.flow) {
      expect(validIds.has(from)).toBe(true);
      expect(validIds.has(to)).toBe(true);
    }
  });
});
