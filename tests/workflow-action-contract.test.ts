import { describe, expect, it } from "bun:test";
import { validateActionArgs, getActionContract, dumpRegistry, listActions, isValidAction } from "../src/action-registry";
import { canonicalActionType } from "../src/assistant-actions";

describe("workflow action contract validation", () => {
  const dump = dumpRegistry();
  const wfActions = listActions("workflow");

  it("has all core workflow actions registered", () => {
    const ids = wfActions.map(a => a.id).sort();
    expect(ids).toContain("workflow.create");
    expect(ids).toContain("workflow.update");
    expect(ids).toContain("workflow.delete");
    expect(ids).toContain("workflow.list");
    expect(ids).toContain("workflow.get");
  });

  it("workflow.create requires elements and flow", () => {
    const result = validateActionArgs("workflow.create", {});
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Missing required argument: elements");
    expect(result.errors).toContain("Missing required argument: flow");
  });

  it("workflow.create accepts valid args", () => {
    const result = validateActionArgs("workflow.create", {
      elements: [{ id: "start", type: "event", label: "Start" }],
      flow: [["start", "end"]],
      name: "Test Workflow",
      draft: true,
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("workflow.delete requires id", () => {
    const result = validateActionArgs("workflow.delete", {});
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Missing required argument: id");
  });

  it("workflow.delete accepts valid args", () => {
    const result = validateActionArgs("workflow.delete", { id: "wf-123" });
    expect(result.valid).toBe(true);
  });

  it("each workflow action returns a contract", () => {
    for (const action of wfActions) {
      const contract = getActionContract(action.id);
      expect(contract).toBeDefined();
      expect(contract!.def.id).toBe(action.id);
      expect(typeof contract!.validate).toBe("function");
    }
  });

  it("unknown action returns undefined contract", () => {
    expect(getActionContract("nonexistent.action")).toBeUndefined();
  });

  it("unknown action returns invalid validation", () => {
    const result = validateActionArgs("nonexistent.action", {});
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("Unknown action");
  });

  it("rejects wrong argument types", () => {
    const result = validateActionArgs("workflow.create", {
      elements: "not-an-array",
      flow: 123,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("array") && e.includes("elements"))).toBe(true);
    expect(result.errors.some(e => e.includes("array") && e.includes("flow"))).toBe(true);
  });

  it("rejects invalid object and number argument types", () => {
    const objectResult = validateActionArgs("case.start", {
      process_id: "wf-123",
      subject: "Case",
      payload: ["not", "an", "object"],
    });
    expect(objectResult.valid).toBe(false);
    expect(objectResult.errors).toContain('Expected object for "payload"');

    const numberResult = validateActionArgs("case.list", { limit: "50" });
    expect(numberResult.valid).toBe(false);
    expect(numberResult.errors).toContain('Expected number for "limit", got string');
  });

  it("case.start requires process_id and subject", () => {
    const result = validateActionArgs("case.start", {});
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Missing required argument: process_id");
    expect(result.errors).toContain("Missing required argument: subject");
  });

  it("element.add validates required fields", () => {
    const result = validateActionArgs("element.add", {});
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Missing required argument: workflow_id");
    expect(result.errors).toContain("Missing required argument: id");
    expect(result.errors).toContain("Missing required argument: type");
    expect(result.errors).toContain("Missing required argument: label");
  });

  it("agent.start requires id", () => {
    const result = validateActionArgs("agent.start", {});
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Missing required argument: id");
  });

  it("isValidAction correctly identifies known and unknown actions", () => {
    expect(isValidAction("workflow.create")).toBe(true);
    expect(isValidAction("case.start")).toBe(true);
    expect(isValidAction("agent.restart")).toBe(true);
    expect(isValidAction("message.send")).toBe(true);
    expect(isValidAction("fake.action")).toBe(false);
  });

  it("canonicalActionType maps legacy ids and is idempotent for canonical ids", () => {
    expect(canonicalActionType("workflow_create")).toBe("workflow.create");
    expect(canonicalActionType("workflow_update")).toBe("workflow.update");
    expect(canonicalActionType("case_start")).toBe("case.start");
    expect(canonicalActionType("message_send")).toBe("message.send");
    expect(canonicalActionType("workflow.create")).toBe("workflow.create");
    expect(canonicalActionType("unknown_custom_action")).toBe("unknown_custom_action");
  });

  it("dumpRegistry version matches ACTION_VERSION", () => {
    expect(dump.version).toBe(2);
    expect(dump.actions.length).toBeGreaterThan(30);
  });

  it("registers people and access actions for API/agent parity", () => {
    expect(isValidAction("person.list")).toBe(true);
    expect(isValidAction("person.upsert")).toBe(true);
    expect(isValidAction("person.delete")).toBe(true);
    expect(isValidAction("access.list")).toBe(true);
    expect(isValidAction("access.approve")).toBe(true);
    expect(isValidAction("access.reject")).toBe(true);
    expect(isValidAction("access.upsert_user")).toBe(true);
    expect(isValidAction("access.add_group")).toBe(true);
    expect(isValidAction("access.remove_user")).toBe(true);
    expect(isValidAction("access.remove_group")).toBe(true);
  });

  it("every registered action has a valid contract", () => {
    for (const action of dump.actions) {
      const contract = getActionContract(action.id);
      expect(contract).toBeDefined();
      expect(contract!.def.scope).toBe(action.scope);

      // Validating with empty args should flag missing required fields
      const result = contract!.validate({});
      const requiredArgs = action.args.filter(a => a.required);
      if (requiredArgs.length > 0) {
        expect(result.valid).toBe(false);
      }
    }
  });
});
