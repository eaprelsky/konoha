import { describe, expect, test } from "bun:test";
import { makeCase, makeRoleDef, makeWorkflowDefinition, makeWorkItem } from "./factories";
import { createTestNamespace } from "./test-namespace";

describe("test factory disposable namespaces", () => {
  test("factory defaults use disposable IDs instead of shared test IDs", () => {
    const role = makeRoleDef();
    const kase = makeCase();
    const workItem = makeWorkItem();
    const workflow = makeWorkflowDefinition();

    expect(role.role_id).toContain("-factory-");
    expect(kase.case_id).toContain("-factory-");
    expect(kase.process_id).toContain("-factory-");
    expect(workItem.work_item_id).toContain("-factory-");
    expect(workItem.case_id).toContain("-factory-");
    expect(workItem.process_id).toContain("-factory-");
    expect(workflow.id).toContain("-factory-");

    expect(kase.process_id).not.toBe("process-test");
    expect(workItem.case_id).not.toBe("case-test");
    expect(workItem.process_id).not.toBe("process-test");
  });

  test("explicit test namespaces create matchable run-scoped IDs", () => {
    const ns = createTestNamespace("cleanup-demo");
    const id = ns.id("agent");

    expect(id).toContain("agent-cleanup-demo-");
    expect(ns.matches(id)).toBe(true);
    expect(ns.matches("agent-other-run")).toBe(false);
  });
});
