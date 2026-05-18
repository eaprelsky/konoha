import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, test } from "bun:test";
import { getAction, getActionSurface } from "../src/action-registry";

const repoRoot = join(import.meta.dir, "..");
const boundaryDoc = readFileSync(join(repoRoot, "docs", "workflow-security-boundary.md"), "utf-8");

function action(id: string) {
  const def = getAction(id);
  expect(def).toBeDefined();
  return getActionSurface(def!);
}

describe("workflow security boundary", () => {
  test("documents the required #789 acceptance sections", () => {
    for (const heading of [
      "## Permission Matrix",
      "## Audit Event Contract",
      "## Token And Secret Handling",
      "## Admin Recovery Controls",
      "## Release Gate",
    ]) {
      expect(boundaryDoc).toContain(heading);
    }

    for (const requiredAction of [
      "workflow.create",
      "workflow.update",
      "workflow.deploy",
      "workflow.delete",
      "case.start",
      "case.cancel",
      "event.confirm",
      "role.update",
      "audit.read",
      "retention.cleanup_apply",
    ]) {
      expect(boundaryDoc).toContain(requiredAction);
    }
  });

  test("keeps workflow construction and deploy actions admin-confirm-audited", () => {
    for (const id of [
      "workflow.create",
      "workflow.update",
      "workflow.deploy",
      "workflow.delete",
      "workflow.batch_delete",
      "element.add",
      "element.update",
      "element.remove",
      "flow.add",
      "flow.remove",
      "trigger.set",
    ]) {
      const surface = action(id);
      expect(surface.security.actor).toBe("admin");
      expect(surface.autonomy).toBe("confirm");
      expect(surface.audited).toBe(true);
    }
  });

  test("keeps runtime recovery and role-binding mutations admin-only and audited", () => {
    const confirmRequired = [
      "case.close",
      "case.cancel",
      "case.delete",
      "retention.cleanup_apply",
      "retention.runtime_cleanup",
    ];

    for (const id of confirmRequired) {
      const surface = action(id);
      expect(surface.security.actor).toBe("admin");
      expect(surface.autonomy).toBe("confirm");
      expect(surface.audited).toBe(true);
    }

    for (const id of [
      "event.confirm",
      "role.create",
      "role.update",
      "role.delete",
    ]) {
      const surface = action(id);
      expect(surface.security.actor).toBe("admin");
      expect(surface.audited).toBe(true);
    }
  });

  test("keeps case starts and payload/audit inspection inside the admin boundary", () => {
    for (const id of ["case.start", "case.get", "case.list", "event.wait_list", "audit.read", "role.list"]) {
      expect(action(id).security.actor).toBe("admin");
    }

    expect(action("case.start").audited).toBe(true);
    expect(action("audit.read").audited).toBe(false);
  });

  test("release gate includes action surface and route authorization guardrails", () => {
    const preReleaseGate = readFileSync(join(repoRoot, "scripts", "pre-release-gate.py"), "utf-8");

    expect(preReleaseGate).toContain("check_action_security_boundary");
    expect(preReleaseGate).toContain("scripts/action-surface-report.ts");
    expect(preReleaseGate).toContain("scripts/check-route-auth-policy.py");
    expect(preReleaseGate).toContain("action_security_boundary");
  });
});
