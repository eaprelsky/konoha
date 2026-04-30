import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { renderMergeReadinessReport } from "../scripts/merge-readiness-report";

const root = join(import.meta.dir, "..");

describe("safe merge readiness protocol", () => {
  test("renders reusable report without authorizing push to main", () => {
    const report = renderMergeReadinessReport({
      branch: "kakashi/123-example",
      base: "origin/main",
      head: "abc1234",
      statusShort: "## kakashi/123-example...origin/main [ahead 1]",
      ahead: 1,
      behind: 0,
      changedFiles: ["docs/safe-merge-cleanup-runbook.md"],
      checks: ["bun x tsc --noEmit: pass"],
      risks: ["none"],
    });

    expect(report).toContain("State: review_required");
    expect(report).toContain("No push to main performed.");
    expect(report).toContain("Reviewer must add merge:ready before integration.");
    expect(report).toContain("- docs/safe-merge-cleanup-runbook.md");
  });

  test("runbook defines states, allowed operations, and forbidden operations", () => {
    const runbook = readFileSync(join(root, "docs/safe-merge-cleanup-runbook.md"), "utf-8");
    for (const state of ["delegated", "in_progress", "local_commit_ready", "review_required", "merge_ready", "merged", "discarded"]) {
      expect(runbook).toContain(state);
    }
    expect(runbook).toContain("Kakashi may:");
    expect(runbook).toContain("Kakashi must not:");
    expect(runbook).toContain("push to `main`");
    expect(runbook).toContain("scripts/merge-readiness-report.ts");
  });

  test("issue template keeps merge gate explicit", () => {
    const template = readFileSync(join(root, ".github/ISSUE_TEMPLATE/safe-merge-cleanup.md"), "utf-8");
    expect(template).toContain("merge:review-required");
    expect(template).toContain("No push to `main` is authorized");
    expect(template).toContain("cleanup after `merged` or `merge:discarded`");
  });
});
