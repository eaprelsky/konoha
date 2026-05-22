import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const repoRoot = join(import.meta.dir, "..");
const reportPath = join(repoRoot, "docs/golden-path-acceptance-closure-report.json");

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf-8");
}

function readReport(): any {
  return JSON.parse(readFileSync(reportPath, "utf-8"));
}

describe("golden-path acceptance closure report", () => {
  test("ties accepted child evidence into the #685 parent without claiming final release", () => {
    const report = readReport();

    expect(report.schema_version).toBe(1);
    expect(report.updated_for_issue).toBe(685);
    expect(report.status).toBe("ready_for_parent_review");
    expect(report.parent_issue).toBe(685);
    expect(report.release_gate_parent).toBe(686);
    expect(report.accepted_child_issues.map((entry: any) => entry.issue)).toEqual([
      745,
      746,
      747,
      748,
    ]);
    expect(report.accepted_child_issues.every((entry: any) => entry.status === "accepted")).toBe(true);
    expect(report.closure_decision.parent_issue_can_close_after_review).toBe(true);
    expect(report.closure_decision.release_gate_686_unblocked_by_this_parent).toBe(true);
    expect(report.closure_decision.package_extraction_618_still_requires_686).toBe(true);
  });

  test("records complete evidence for every required golden-path step", () => {
    const report = readReport();

    expect(report.acceptance_steps.map((step: any) => step.step)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (const step of report.acceptance_steps) {
      expect(step.status).toBe("covered");
      expect(step.name).toEqual(expect.any(String));
      expect(step.durability_contract).toEqual(expect.any(String));
      expect(step.evidence.length).toBeGreaterThan(0);
      for (const file of step.evidence) {
        expect(existsSync(join(repoRoot, file)), `${file} should exist`).toBe(true);
      }
    }
  });

  test("keeps no-fake-success guards explicit and backed by focused fixtures", () => {
    const report = readReport();
    const guards = report.no_fake_success_guards;

    expect(guards.client_only_state_counted).toBe(false);
    expect(guards.textual_assistant_reply_counted).toBe(false);
    expect(guards.preview_only_patch_counted).toBe(false);
    expect(guards.partial_deploy_counted_as_runnable).toBe(false);
    expect(guards.failed_dispatch_counted_as_delivered).toBe(false);
    expect(guards.evidence).toContain("ProcessEditor reload assertion in e2e/AssistantWidgetGoldenPath-747.spec.ts");

    const assistantFixture = readRepoFile("tests/assistant-create-validate-deploy-run-fixture.test.ts");
    expect(assistantFixture).toContain("fixture_response");
    expect(assistantFixture).toContain("action_sequence");
    expect(assistantFixture).toContain("case.start");
    expect(assistantFixture).toContain("skipped");

    const backendGolden = readRepoFile("tests/backend-golden-path.test.ts");
    expect(backendGolden).toContain("WORKFLOW_NOT_EXECUTABLE");
    expect(backendGolden).toContain("ROLE_UNRESOLVABLE");
    expect(backendGolden).toContain("TRIGGER_READINESS_INVALID");
    expect(backendGolden).toContain("GRAPH_INVALID_TERMINAL_STATE");
    expect(backendGolden).toContain("WORKFLOW_DEPLOY_SIDE_EFFECT_FAILED");
    expect(backendGolden).toContain("dead_letter");

    const browserGolden = readRepoFile("e2e/AssistantWidgetGoldenPath-747.spec.ts");
    expect(browserGolden).toContain("page.reload");
    expect(browserGolden).toContain("workflow.deploy");
    expect(browserGolden).toContain("case.start");
    expect(browserGolden).toContain("/ui/workitems");
  });

  test("negative coverage blocks invalid workflows before runnable success", () => {
    const report = readReport();
    const cases = new Map(report.negative_coverage.map((entry: any) => [entry.case, entry.expected]));

    expect(cases.get("deploy readiness failure")).toContain("no case");
    expect(cases.get("case.start before deploy")).toContain("WORKFLOW_NOT_EXECUTABLE");
    expect(cases.get("missing role")).toContain("ROLE_UNRESOLVABLE");
    expect(cases.get("invalid trigger")).toContain("TRIGGER_READINESS_INVALID");
    expect(cases.get("invalid graph")).toContain("GRAPH_INVALID_TERMINAL_STATE");
    expect(cases.get("deploy side-effect failure")).toContain("WORKFLOW_DEPLOY_SIDE_EFFECT_FAILED");
    expect(cases.get("work-item dispatch transport failure")).toContain("dead_letter");
  });

  test("release checklist links the #685 parent closure and commands", () => {
    const checklistMd = readRepoFile("docs/workflow-constructor-runtime-release-checklist.md");
    const checklistJson = JSON.parse(readRepoFile("docs/workflow-constructor-runtime-release-checklist.json"));

    expect(checklistMd).toContain("docs/golden-path-acceptance-closure-report.md");
    expect(checklistMd).toContain("e2e/AssistantWidgetGoldenPath-747.spec.ts");
    expect(checklistMd).toContain("tests/golden-path-acceptance-closure-report.test.ts");

    expect(checklistJson.golden_path_acceptance.issue).toBe(685);
    expect(checklistJson.golden_path_acceptance.closure_report).toBe("docs/golden-path-acceptance-closure-report.json");
    expect(checklistJson.golden_path_acceptance.child_issues).toEqual([745, 746, 747, 748]);
    expect(checklistJson.golden_path_acceptance.required_commands.join("\n")).toContain("tests/backend-golden-path.test.ts");
    expect(checklistJson.golden_path_acceptance.required_commands.join("\n")).toContain("e2e/AssistantWidgetGoldenPath-747.spec.ts");
  });

  test("review commands preserve JSON, backend, browser, Action Spine, auth, typecheck, and diff checks", () => {
    const report = readReport();
    const commands = report.review_commands.join("\n");

    expect(commands).toContain("json.tool docs/golden-path-acceptance-closure-report.json");
    expect(commands).toContain("tests/golden-path-acceptance-closure-report.test.ts");
    expect(commands).toContain("tests/assistant-create-validate-deploy-run-fixture.test.ts");
    expect(commands).toContain("tests/backend-golden-path.test.ts");
    expect(commands).toContain("e2e/AssistantWidgetGoldenPath-747.spec.ts");
    expect(commands).toContain("scripts/action-surface-report.ts --check");
    expect(commands).toContain("scripts/check-route-auth-policy.py");
    expect(commands).toContain("bun run typecheck");
    expect(commands).toContain("git diff --check");
  });
});
