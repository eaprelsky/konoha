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

describe("state-machine core parent closure report", () => {
  test("maps #680 acceptance criteria to closed child evidence", () => {
    const report = readJson("docs/state-machine-core-closure-report.json");
    const coverage = new Map(report.acceptance_coverage.map((item: any) => [item.criterion, item]));

    expect(report.updated_for_issue).toBe(680);
    expect(report.status).toBe("ready_for_parent_review");
    expect(report.accepted_child_issues).toEqual([725, 726, 727, 728]);
    expect(coverage.size).toBe(6);
    for (const item of report.acceptance_coverage) {
      expect(item.status).toBe("covered");
      expect(item.evidence.length).toBeGreaterThanOrEqual(2);
    }
    expect((coverage.get("side effects are emitted as commands or intents, not executed inline by transition logic") as any).intent_kinds).toEqual([
      "gateway.evaluated",
      "function.work_item",
      "event.wait",
      "case.complete",
      "case.error",
      "subprocess.spawn",
      "subprocess.parent_complete",
    ]);
  });

  test("keeps workflow docs linked to the planner and effect boundary", () => {
    const workflowEngine = read("docs/workflow-engine.md");
    const closure = read("docs/state-machine-core-closure-report.md");

    for (const expected of [
      "transition-planner.ts",
      "does not write Redis/PostgreSQL",
      "effect intents",
      "subprocess-effects.ts",
      "tests/state-machine-transition-fixtures.test.ts",
    ]) {
      expect(workflowEngine).toContain(expected);
    }
    expect(closure).toContain("Issue #680");
    expect(closure).toContain("#725, #726, #727, and #728");
    expect(closure).toContain("#812 terminal-case gate");
  });

  test("pure planner source has no runtime side-effect operations", () => {
    const report = readJson("docs/state-machine-core-closure-report.json");
    const planner = read("src/runtime/cases/transition-planner.ts");
    const fixture = read("tests/fixtures/state-machine-transition-fixtures.ts");

    for (const forbidden of report.pure_planner_forbidden_operations) {
      expect(planner).not.toContain(forbidden);
    }
    expect(planner).toContain("GraphTransitionEffectIntent");
    expect(planner).toContain("planGraphTransition");
    expect(planner).toContain("planGraphJoinTransition");
    expect(fixture).not.toContain("src/redis");
    expect(fixture).not.toContain("adapter.invoke");
    expect(fixture).not.toContain("sendTelegram");
  });

  test("declares review commands for planner, eEPC, action surface, auth, and typecheck checks", () => {
    const report = readJson("docs/state-machine-core-closure-report.json");

    expect(report.review_commands.some((command: string) => command.includes("tests/state-machine-core-closure-report.test.ts"))).toBe(true);
    expect(report.review_commands.some((command: string) => command.includes("tests/graph-transition-planner.test.ts"))).toBe(true);
    expect(report.review_commands.some((command: string) => command.includes("tests/eepc-state-machine-regression.test.ts"))).toBe(true);
    expect(report.review_commands).toContain("PATH=/home/ubuntu/.bun/bin:$PATH bun run scripts/action-surface-report.ts --check");
    expect(report.review_commands).toContain("python3 scripts/check-route-auth-policy.py");
    expect(report.review_commands).toContain("PATH=/home/ubuntu/.bun/bin:$PATH bun run typecheck");
    expect(report.closure_decision.parent_issue_can_close_after_review).toBe(true);
    expect(report.closure_decision.release_claim_unblocked).toBe(false);
  });
});
