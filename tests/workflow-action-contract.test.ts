import { describe, expect, it } from "bun:test";
import { ACTION_VERSION, classifyAction, validateActionArgs, getActionContract, dumpRegistry, listActions, isValidAction, listActionSurface } from "../src/action-registry";
import { validateEnvelope } from "../src/act-envelope";
import { canonicalActionType } from "../src/assistant-actions";

describe("workflow action contract validation", () => {
  const dump = dumpRegistry();
  const wfActions = listActions("workflow");

  it("has all core workflow actions registered", () => {
    const ids = wfActions.map(a => a.id).sort();
    expect(ids).toContain("workflow.create");
    expect(ids).toContain("workflow.update");
    expect(ids).toContain("workflow.deploy");
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

  it("workflow.deploy requires id", () => {
    const missing = validateActionArgs("workflow.deploy", {});
    expect(missing.valid).toBe(false);
    expect(missing.errors).toContain("Missing required argument: id");

    const valid = validateActionArgs("workflow.deploy", { id: "wf-123" });
    expect(valid.valid).toBe(true);
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

    const workItemResult = validateActionArgs("workitem.list", { case_id: 123 });
    expect(workItemResult.valid).toBe(false);
    expect(workItemResult.errors).toContain('Expected string for "case_id", got number');
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

  it("flow add/remove validates required fields", () => {
    const add = validateActionArgs("flow.add", {});
    expect(add.valid).toBe(false);
    expect(add.errors).toContain("Missing required argument: workflow_id");
    expect(add.errors).toContain("Missing required argument: from");
    expect(add.errors).toContain("Missing required argument: to");

    const remove = validateActionArgs("flow.remove", {});
    expect(remove.valid).toBe(false);
    expect(remove.errors).toContain("Missing required argument: workflow_id");
    expect(remove.errors).toContain("Missing required argument: from");
    expect(remove.errors).toContain("Missing required argument: to");
  });

  it("classifies workflow edit and lifecycle verbs as mutations", () => {
    const byId = new Map(listActionSurface().map(action => [action.id, action]));
    for (const id of [
      "element.add",
      "flow.add",
      "trigger.set",
      "trigger.resolve",
      "workflow.deploy",
      "workflow.batch_delete",
    ]) {
      expect(byId.get(id)?.category).toBe("act");
      expect(byId.get(id)?.audited).toBe(true);
    }

    expect(classifyAction("workflow.retire")).toBe("act");
    expect(classifyAction("workflow.validate")).toBe("act");
  });

  it("rejects read-only envelopes for workflow edit mutations", () => {
    const args = {
      workflow_id: "wf-123",
      id: "f_review",
      type: "function",
      label: "Review",
    };

    expect(validateEnvelope({ action: "element.add", category: "act", args })).toEqual([]);
    expect(validateEnvelope({ action: "element.add", category: "inspect", args })).toContainEqual({
      field: "category",
      message: "Action element.add is category 'act', not 'inspect'",
    });
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
    expect(isValidAction("connector.send_message")).toBe(true);
    expect(isValidAction("fake.action")).toBe(false);
  });

  it("canonicalActionType maps legacy ids and is idempotent for canonical ids", () => {
    expect(canonicalActionType("workflow_create")).toBe("workflow.create");
    expect(canonicalActionType("workflow_update")).toBe("workflow.update");
    expect(canonicalActionType("workflow_deploy")).toBe("workflow.deploy");
    expect(canonicalActionType("case_start")).toBe("case.start");
    expect(canonicalActionType("message_send")).toBe("message.send");
    expect(canonicalActionType("workflow.create")).toBe("workflow.create");
    expect(canonicalActionType("unknown_custom_action")).toBe("unknown_custom_action");
  });

  it("dumpRegistry version matches ACTION_VERSION", () => {
    expect(dump.version).toBe(ACTION_VERSION);
    expect(dump.actions.length).toBeGreaterThan(30);
    expect(dump.surface.length).toBe(dump.actions.length);
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

  it("registers connector outbound action for messenger/API/agent parity", () => {
    expect(isValidAction("connector.send_message")).toBe(true);

    const missing = validateActionArgs("connector.send_message", {});
    expect(missing.valid).toBe(false);
    expect(missing.errors).toContain("Missing required argument: connector_id");
    expect(missing.errors).toContain("Missing required argument: endpoint_id");
    expect(missing.errors).toContain("Missing required argument: chat_ref");
    expect(missing.errors).toContain("Missing required argument: text");

    const valid = validateActionArgs("connector.send_message", {
      connector_id: "telegram-main",
      endpoint_id: "telegram-user-sasuke",
      chat_ref: "-4982206077",
      text: "dry-run",
      dry_run: true,
      metadata: { case_id: "case-1" },
    });
    expect(valid.valid).toBe(true);
  });

  it("registers assistant invocation action for API/MCP/testbench parity", () => {
    expect(isValidAction("assistant.invoke")).toBe(true);

    const missing = validateActionArgs("assistant.invoke", {});
    expect(missing.valid).toBe(false);
    expect(missing.errors).toContain("Missing required argument: assistant_id");
    expect(missing.errors).toContain("Missing required argument: message");

    const valid = validateActionArgs("assistant.invoke", {
      assistant_id: "tsunade",
      message: "test",
      stream: false,
      persist_history: false,
      fixture_response: "{\"reply\":\"ok\"}",
    });
    expect(valid.valid).toBe(true);
  });

  it("registers retention report as a read-only admin action", () => {
    expect(isValidAction("retention.report")).toBe(true);
    expect(isValidAction("retention.cleanup_preview")).toBe(true);
    expect(isValidAction("retention.cleanup_apply")).toBe(true);
    expect(isValidAction("retention.runtime_cleanup")).toBe(true);

    const valid = validateActionArgs("retention.report", { limit: 20 });
    expect(valid.valid).toBe(true);

    const previewValid = validateActionArgs("retention.cleanup_preview", { limit: 20 });
    expect(previewValid.valid).toBe(true);

    const applyMissing = validateActionArgs("retention.cleanup_apply", {});
    expect(applyMissing.valid).toBe(false);
    expect(applyMissing.errors).toContain("Missing required argument: confirm");
    expect(applyMissing.errors).toContain("Missing required argument: candidates");

    const applyValid = validateActionArgs("retention.cleanup_apply", {
      confirm: true,
      candidates: [{ entity: "cases", id: "case-1", candidate: "safe_candidate:old_completed_cases" }],
    });
    expect(applyValid.valid).toBe(true);

    const runtimeCleanupValid = validateActionArgs("retention.runtime_cleanup", {
      dry_run: true,
      stuck_case_ttl_hours: 24,
      completed_workflow_ttl_hours: 12,
      max_delete: 50,
    });
    expect(runtimeCleanupValid.valid).toBe(true);

    const surface = listActionSurface().find(action => action.id === "retention.report");
    expect(surface).toMatchObject({
      id: "retention.report",
      category: "inspect",
      implemented: true,
      security: { actor: "admin" },
    });

    const previewSurface = listActionSurface().find(action => action.id === "retention.cleanup_preview");
    expect(previewSurface).toMatchObject({
      id: "retention.cleanup_preview",
      category: "inspect",
      implemented: true,
      security: { actor: "admin" },
    });

    const applySurface = listActionSurface().find(action => action.id === "retention.cleanup_apply");
    expect(applySurface).toMatchObject({
      id: "retention.cleanup_apply",
      category: "act",
      implemented: true,
      security: { actor: "admin" },
      audited: true,
    });

    const runtimeCleanupSurface = listActionSurface().find(action => action.id === "retention.runtime_cleanup");
    expect(runtimeCleanupSurface).toMatchObject({
      id: "retention.runtime_cleanup",
      category: "act",
      implemented: true,
      security: { actor: "admin" },
      audited: true,
    });
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

  it("every action has explicit surface metadata for GUI/API/MCP/testbench parity", () => {
    const surface = listActionSurface();
    const planned = new Set([
      "element.update",
      "element.remove",
      "trigger.set",
      "trigger.resolve",
      "event.wait_list",
    ]);

    expect(surface.length).toBe(dump.actions.length);
    for (const action of surface) {
      expect(["act", "inspect", "drill"]).toContain(action.category);
      expect(["direct", "endpoint", "registered-handler", "planned"]).toContain(action.implementation.kind);
      expect(["admin", "authenticated", "agent_self"]).toContain(action.security.actor);
      if (action.implementation.kind === "planned") {
        expect(planned.has(action.id)).toBe(true);
        expect(action.implementation.note?.length ?? 0).toBeGreaterThan(10);
      } else {
        expect(action.implemented).toBe(true);
      }
      if (action.category === "act" && action.implemented) {
        expect(action.audited).toBe(true);
      }
    }
  });

  it("exposes expected actor policies for sensitive and agent-safe actions", () => {
    const byId = new Map(listActionSurface().map(action => [action.id, action]));
    expect(byId.get("workflow.create")?.security.actor).toBe("admin");
    expect(byId.get("case.list")?.security.actor).toBe("admin");
    expect(byId.get("workitem.complete")?.security.actor).toBe("admin");
    expect(byId.get("access.upsert_user")?.security.actor).toBe("admin");
    expect(byId.get("audit.read")?.security.actor).toBe("admin");
    expect(byId.get("message.send")?.security.actor).toBe("authenticated");
    expect(byId.get("message.read")?.security).toEqual({ actor: "agent_self", selfArg: "agent_id" });
    expect(byId.get("knowledge.read")?.security.actor).toBe("authenticated");
    expect(byId.get("assistant.invoke")?.security.actor).toBe("authenticated");
  });
});
