import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const repoRoot = join(import.meta.dir, "..");

function read(path: string): string {
  return readFileSync(join(repoRoot, path), "utf-8");
}

function readJson(path: string): any {
  return JSON.parse(read(path));
}

describe("role readiness parent closure report", () => {
  test("maps #679 acceptance criteria to accepted child evidence", () => {
    const report = readJson("docs/role-readiness-closure-report.json");
    const coverage = new Map(report.acceptance_coverage.map((item: any) => [item.criterion, item]));

    expect(report.updated_for_issue).toBe(679);
    expect(report.status).toBe("ready_for_parent_review");
    expect(report.accepted_child_issues).toEqual([721, 722, 723, 724]);
    expect(coverage.size).toBe(6);
    for (const item of report.acceptance_coverage) {
      expect(item.status).toBe("covered");
      expect(item.evidence.length).toBeGreaterThanOrEqual(2);
    }
    expect((coverage.get("workflow.validate reports missing or unresolvable roles as blocking readiness errors") as any).stable_codes).toEqual([
      "ROLE_UNRESOLVABLE",
      "ROLE_MISSING_ASSIGNEE",
      "ROLE_ASSIGNEE_UNRESOLVABLE",
    ]);
    expect((coverage.get("dispatch receipts show actual target agent, person, system, or manual queue") as any).required_receipt_fields).toEqual([
      "target_type",
      "target_id",
      "target_ids",
      "strategy",
      "dispatch_status",
      "targets",
    ]);
  });

  test("keeps manual and system role direct paths explicit", () => {
    const report = readJson("docs/role-readiness-closure-report.json");
    const direct = new Map(report.direct_paths_kept.map((item: any) => [item.path, item]));

    expect(report.target_invariant).toContain("every function role resolves");
    expect(report.target_invariant).toContain("target evidence");
    expect(direct.get("manual queue").reason).toContain("explicit queue target");
    expect(direct.get("system role").reason).toContain("system-agent");
  });

  test("links workflow docs to readiness, remediation, assistant, and dispatch receipt contracts", () => {
    const workflowEngine = read("docs/workflow-engine.md");
    const closure = read("docs/role-readiness-closure-report.md");

    for (const expected of [
      "ROLE_UNRESOLVABLE",
      "ROLE_MISSING_ASSIGNEE",
      "ROLE_ASSIGNEE_UNRESOLVABLE",
      "role.create",
      "role.update",
      "role_assignment",
      "target_type",
      "target_id",
      "dispatch_status",
      "targets[]",
    ]) {
      expect(workflowEngine).toContain(expected);
    }
    expect(closure).toContain("Issue #679");
    expect(closure).toContain("#721, #722, #723, and #724");
    expect(closure).toContain("#812");
  });

  test("declares review commands for backend, frontend, action surface, auth, and typecheck checks", () => {
    const report = readJson("docs/role-readiness-closure-report.json");

    expect(report.review_commands.some((command: string) => command.includes("tests/role-readiness-closure-report.test.ts"))).toBe(true);
    expect(report.review_commands.some((command: string) => command.includes("tests/workflow-role-readiness.test.ts"))).toBe(true);
    expect(report.review_commands.some((command: string) => command.includes("roleAssignmentResolution"))).toBe(true);
    expect(report.review_commands).toContain("PATH=/home/ubuntu/.bun/bin:$PATH bun run scripts/action-surface-report.ts --check");
    expect(report.review_commands).toContain("python3 scripts/check-route-auth-policy.py");
    expect(report.review_commands).toContain("PATH=/home/ubuntu/.bun/bin:$PATH bun run typecheck");
    expect(report.closure_decision.parent_issue_can_close_after_review).toBe(true);
    expect(report.closure_decision.release_claim_unblocked).toBe(false);
  });
});
