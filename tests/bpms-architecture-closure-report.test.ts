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

describe("BPMS architecture closure report", () => {
  test("defines the durable constructor-to-runtime success invariant", () => {
    const report = readJson("docs/bpms-architecture-closure-report.json");
    const invariant = report.target_invariant;

    expect(report.updated_for_issue).toBe(672);
    expect(report.status).toBe("ready_for_epic_review_with_explicit_gates");
    expect(invariant.statement).toContain("No assistant or operator path may claim execution success");
    expect(invariant.required_receipts).toEqual([
      "workflow.validate canonical readiness receipt",
      "workflow.patch durable edit receipt for committed constructor changes",
      "workflow.deploy transaction/deploy-record receipt before start subscriptions are materialized",
      "case.start receipt bound to an executable deployed workflow snapshot",
      "workitem.dispatch/runtime-effect receipt for asynchronous delivery",
      "audit/timeline receipt for recovery or operator mutation paths",
    ]);
    expect(invariant.forbidden_success_claims).toContain("client-only schema_patch treated as saved");
    expect(invariant.forbidden_success_claims).toContain("case.start success for non-executable workflow");
  });

  test("covers M1 through M6 with accepted evidence links and focused tests", () => {
    const report = readJson("docs/bpms-architecture-closure-report.json");
    const milestones = new Map(report.milestone_evidence.map((item: any) => [item.milestone, item]));

    expect([...milestones.keys()]).toEqual(["M1", "M2", "M3", "M4", "M5", "M6"]);
    expect(milestones.get("M2").issues).toContain(688);
    expect(milestones.get("M3").issues).toContain(698);
    expect(milestones.get("M4").issues).toContain(715);
    expect(milestones.get("M5").issues).toContain(740);
    expect(milestones.get("M6").issues).toContain(747);

    for (const milestone of report.milestone_evidence) {
      expect(milestone.status).toMatch(/completed/);
      expect(milestone.evidence.length).toBeGreaterThanOrEqual(3);
      expect(milestone.closure_note).toBeTruthy();
    }
  });

  test("records umbrella capability parents separately from detailed closed slices", () => {
    const report = readJson("docs/bpms-architecture-closure-report.json");
    const parents = new Map(report.capability_parent_status.map((item: any) => [item.issue, item]));

    expect(parents.get(673).state).toBe("closed");
    expect(parents.get(678).state).toBe("open");
    expect(parents.get(678).resolution).toContain("#715-#720");
    expect(parents.get(679).resolution).toContain("#721-#724");
    expect(parents.get(685).resolution).toContain("#745-#748");
    expect(parents.get(686).resolution).toContain("#749-#751");
  });

  test("keeps #812 release gate and #618 extraction gate explicit", () => {
    const report = readJson("docs/bpms-architecture-closure-report.json");
    const gates = new Map(report.known_external_gates.map((item: any) => [item.issue, item]));

    expect(gates.get(812).gate).toBe("terminal-case rule");
    expect(gates.get(812).impact).toContain("terminal cases do not receive new work");
    expect(gates.get(618).gate).toBe("Action Spine package extraction");
    expect(gates.get(618).current_policy).toContain("No package move");
    expect(report.closure_decision.release_claim_unblocked).toBe(false);
    expect(report.closure_decision.package_extraction_unblocked).toBe(false);
  });

  test("links to existing release, rollback, storage, and extraction contracts", () => {
    const markdown = read("docs/bpms-architecture-closure-report.md");
    const releaseChecklist = readJson("docs/workflow-constructor-runtime-release-checklist.json");
    const rollback = readJson("docs/workflow-runtime-rollback-recovery.json");
    const graph = readJson("docs/bpms-program-dependency-graph.json");

    expect(markdown).toContain("constructor -> validate -> deploy -> run");
    expect(markdown).toContain("#812 remains the terminal-case rule gate");
    expect(markdown).toContain("#618 remains the Action Spine package extraction issue");
    expect(releaseChecklist.parent_issue).toBe(686);
    expect(releaseChecklist.reviewer_checklist.map((item: any) => item.id)).toContain("terminal-case-rule");
    expect(rollback.terminal_case_rule.rule).toContain("terminal Workflow Engine cases must not receive new routed work");
    expect(graph.program.epic).toBe(672);
  });

  test("declares review commands for action surface, route auth, health policy, and typecheck", () => {
    const report = readJson("docs/bpms-architecture-closure-report.json");

    expect(report.review_commands.some((command: string) => command.includes("tests/bpms-architecture-closure-report.test.ts"))).toBe(true);
    expect(report.review_commands).toContain("PATH=/home/ubuntu/.bun/bin:$PATH bun run scripts/action-surface-report.ts --check");
    expect(report.review_commands).toContain("python3 scripts/check-route-auth-policy.py");
    expect(report.review_commands).toContain("python3 -m pytest tests/test_service_profiles.py tests/test_healthcheck_policy.py");
    expect(report.review_commands).toContain("PATH=/home/ubuntu/.bun/bin:$PATH bun run typecheck");
  });
});
