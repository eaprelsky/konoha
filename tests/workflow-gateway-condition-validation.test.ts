import { describe, expect, test } from "bun:test";
import { validateWorkflowReadiness, type WorkflowDefinition } from "../src/workflow-loader";
import { analyzeGatewayCondition } from "../src/workflow-gateway-conditions";
import { makeWorkflowDefinition } from "./factories";

function gatewayWorkflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return makeWorkflowDefinition({
    elements: [
      { id: "start", type: "event", label: "Start", trigger: { kind: "manual", manual_override: true } },
      { id: "prepare", type: "function", label: "Prepare", role: "Operator" },
      { id: "prepared", type: "event", label: "Prepared" },
      { id: "route", type: "gateway", label: "Route", operator: "XOR" },
      { id: "path_a", type: "event", label: "Path A" },
      { id: "handle_a", type: "function", label: "Handle A", role: "Operator" },
      { id: "done_a", type: "event", label: "Done A" },
      { id: "path_default", type: "event", label: "Default path" },
      { id: "handle_default", type: "function", label: "Handle default", role: "Operator" },
      { id: "done_default", type: "event", label: "Done default" },
    ],
    flow: [
      ["start", "prepare"],
      ["prepare", "prepared"],
      ["prepared", "route"],
      ["route", "path_a", "payload.path === 'a'"],
      ["path_a", "handle_a"],
      ["handle_a", "done_a"],
      ["route", "path_default"],
      ["path_default", "handle_default"],
      ["handle_default", "done_default"],
    ],
    ...overrides,
  });
}

function codes(def: WorkflowDefinition): string[] {
  return validateWorkflowReadiness(def, {
    roles: [{ role_id: "Operator", assignees: ["kakashi"], strategy: "round-robin" }],
  }).errors.map(error => error.code);
}

function warningCodes(def: WorkflowDefinition): string[] {
  return validateWorkflowReadiness(def, {
    roles: [{ role_id: "Operator", assignees: ["kakashi"], strategy: "round-robin" }],
  }).warnings.map(warning => warning.code);
}

describe("workflow gateway condition validation", () => {
  test("accepts documented payload comparisons and boolean composition", () => {
    const def = gatewayWorkflow({
      payload_fields: ["review_route", "closure_allowed"],
      flow: [
        ["start", "prepare"],
        ["prepare", "prepared"],
        ["prepared", "route"],
        ["route", "path_a", "payload.review_route === 'approved' && payload.closure_allowed === true"],
        ["path_a", "handle_a"],
        ["handle_a", "done_a"],
        ["route", "path_default"],
        ["path_default", "handle_default"],
        ["handle_default", "done_default"],
      ],
    });

    expect(codes(def)).not.toContain("GRAPH_INVALID_GATEWAY_CONDITION");
    expect(codes(def)).not.toContain("GRAPH_UNSUPPORTED_GATEWAY_CONDITION");
    expect(codes(def)).not.toContain("GRAPH_UNKNOWN_PAYLOAD_DEPENDENCY");
    expect(codes(def)).not.toContain("GRAPH_GATEWAY_MISSING_DEFAULT");
  });

  test("reports malformed condition syntax with a stable graph code", () => {
    const def = gatewayWorkflow({
      flow: [
        ["start", "prepare"],
        ["prepare", "prepared"],
        ["prepared", "route"],
        ["route", "path_a", "payload. ==="],
        ["path_a", "handle_a"],
        ["handle_a", "done_a"],
        ["route", "path_default"],
        ["path_default", "handle_default"],
        ["handle_default", "done_default"],
      ],
    });

    expect(codes(def)).toContain("GRAPH_INVALID_GATEWAY_CONDITION");
  });

  test("rejects unsupported unsafe expression surface before deploy readiness", () => {
    const def = gatewayWorkflow({
      flow: [
        ["start", "prepare"],
        ["prepare", "prepared"],
        ["prepared", "route"],
        ["route", "path_a", "payload.constructor === 'a'"],
        ["path_a", "handle_a"],
        ["handle_a", "done_a"],
        ["route", "path_default"],
        ["path_default", "handle_default"],
        ["handle_default", "done_default"],
      ],
    });

    expect(codes(def)).toContain("GRAPH_UNSUPPORTED_GATEWAY_CONDITION");
  });

  test("rejects Object prototype payload segments before dependency inference", () => {
    const def = gatewayWorkflow({
      flow: [
        ["start", "prepare"],
        ["prepare", "prepared"],
        ["prepared", "route"],
        ["route", "path_a", "payload.toString !== undefined"],
        ["path_a", "handle_a"],
        ["handle_a", "done_a"],
        ["route", "path_default"],
        ["path_default", "handle_default"],
        ["handle_default", "done_default"],
      ],
    });

    expect(codes(def)).toContain("GRAPH_UNSUPPORTED_GATEWAY_CONDITION");
  });

  test("reports unknown payload dependencies when a payload contract is declared", () => {
    const def = gatewayWorkflow({
      payload_fields: ["path"],
      flow: [
        ["start", "prepare"],
        ["prepare", "prepared"],
        ["prepared", "route"],
        ["route", "path_a", "payload.missing_field === 'a'"],
        ["path_a", "handle_a"],
        ["handle_a", "done_a"],
        ["route", "path_default"],
        ["path_default", "handle_default"],
        ["handle_default", "done_default"],
      ],
    });
    const receipt = validateWorkflowReadiness(def, {
      roles: [{ role_id: "Operator", assignees: ["kakashi"], strategy: "round-robin" }],
    });

    expect(receipt.errors).toContainEqual(expect.objectContaining({
      code: "GRAPH_UNKNOWN_PAYLOAD_DEPENDENCY",
      class: "graph",
      element_id: "route",
      details: expect.objectContaining({
        dependency: "missing_field",
        declared_payload_fields: ["path"],
      }),
    }));
  });

  test("reports missing deterministic default branch for multi-branch XOR gateways", () => {
    const def = gatewayWorkflow({
      flow: [
        ["start", "prepare"],
        ["prepare", "prepared"],
        ["prepared", "route"],
        ["route", "path_a", "payload.path === 'a'"],
        ["path_a", "handle_a"],
        ["handle_a", "done_a"],
        ["route", "path_default", "payload.path !== 'a'"],
        ["path_default", "handle_default"],
        ["handle_default", "done_default"],
      ],
    });

    expect(warningCodes(def)).toContain("GRAPH_GATEWAY_MISSING_DEFAULT");
  });

  test("keeps existing eEPC gateway condition expressions in the supported DSL", () => {
    expect(analyzeGatewayCondition("payload.safe_auto_recovery_allowed !== true && payload.suppression_review_required !== true")).toMatchObject({
      ok: true,
      dependencies: ["safe_auto_recovery_allowed", "suppression_review_required"],
    });
  });
});
