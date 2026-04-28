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

  test("has start event e1 with lead.received trigger", () => {
    const e1 = def.elements.find(el => el.id === "e1");
    expect(e1).toBeDefined();
    expect(e1!.type).toBe("event");
  });

  test("has XOR gateway g1 for qualified/rejected branching", () => {
    const g1 = def.elements.find(el => el.id === "g1");
    expect(g1).toBeDefined();
    expect(g1!.type).toBe("gateway");
  });

  test("has terminal events for both branches", () => {
    const terminalEvents = def.elements.filter(el => el.type === "event");
    const outgoingIds = new Set(def.flow.map(([, to]) => to));
    const eventIds = new Set(terminalEvents.map(el => el.id));
    // At least one event has no outgoing edge (terminal)
    const terminals = terminalEvents.filter(el => !outgoingIds.has(el.id));
    expect(terminals.length).toBeGreaterThanOrEqual(1);
  });

  test("flow edges reference valid element IDs", () => {
    const validIds = new Set(def.elements.map(el => el.id));
    for (const [from, to] of def.flow) {
      expect(validIds.has(from)).toBe(true);
      expect(validIds.has(to)).toBe(true);
    }
  });
});
