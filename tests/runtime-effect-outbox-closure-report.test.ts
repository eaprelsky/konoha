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

describe("runtime effect outbox parent closure report", () => {
  test("maps #678 acceptance criteria to closed child evidence", () => {
    const report = readJson("docs/runtime-effect-outbox-closure-report.json");
    const coverage = new Map(report.acceptance_coverage.map((item: any) => [item.criterion, item]));

    expect(report.updated_for_issue).toBe(678);
    expect(report.status).toBe("ready_for_parent_review");
    expect(report.closed_child_issues).toEqual([715, 716, 717, 718, 719, 720, 729, 730, 731, 732]);
    expect(coverage.size).toBe(7);
    for (const item of report.acceptance_coverage) {
      expect(item.status).toBe("covered");
      expect(item.evidence.length).toBeGreaterThanOrEqual(2);
    }
    expect((coverage.get("connector notifications can be represented and delivered through outbox") as any).evidence)
      .toContain("tests/connector-outbox.test.ts");
  });

  test("keeps direct paths explicit instead of treating them as silent success", () => {
    const report = readJson("docs/runtime-effect-outbox-closure-report.json");
    const directPaths = new Map(report.direct_paths_kept.map((item: any) => [item.path, item]));

    expect(report.target_invariant).toContain("durably represented by runtime effect records");
    expect(directPaths.get("sync adapter bindings").reason).toContain("immediate deterministic output");
    expect(directPaths.get("manual subscriptions/direct admin subscription commands").reason).toContain("durable source of truth");
    expect(directPaths.get("explicit operator connector.send_message Action Spine calls").reason).toContain("deliberate actions");
  });

  test("links runtime outbox docs to connector, dispatch, adapter, subscription, reminder, and recovery contracts", () => {
    const markdown = read("docs/runtime-effect-outbox.md");
    const closure = read("docs/runtime-effect-outbox-closure-report.md");

    for (const expected of [
      "connector.send_message",
      "workitem.dispatch",
      "adapter.invoke",
      "subscription.create",
      "subscription.cancel",
      "reminder.schedule",
      "runtime.effect.dead_lettered",
      "runtime_effect.<operation>",
    ]) {
      expect(markdown).toContain(expected);
    }
    expect(closure).toContain("Issue #678");
    expect(closure).toContain("This parent pass also wires the previously reserved");
    expect(closure).toContain("#812 terminal-case gate");
  });

  test("declares review commands for focused outbox, action surface, auth, and typecheck checks", () => {
    const report = readJson("docs/runtime-effect-outbox-closure-report.json");

    expect(report.review_commands.some((command: string) => command.includes("tests/connector-outbox.test.ts"))).toBe(true);
    expect(report.review_commands.some((command: string) => command.includes("tests/workitem-dispatch-outbox.test.ts"))).toBe(true);
    expect(report.review_commands).toContain("PATH=/home/ubuntu/.bun/bin:$PATH bun run scripts/action-surface-report.ts --check");
    expect(report.review_commands).toContain("python3 scripts/check-route-auth-policy.py");
    expect(report.review_commands).toContain("PATH=/home/ubuntu/.bun/bin:$PATH bun run typecheck");
    expect(report.closure_decision.parent_issue_can_close_after_review).toBe(true);
    expect(report.closure_decision.release_claim_unblocked).toBe(false);
  });
});
