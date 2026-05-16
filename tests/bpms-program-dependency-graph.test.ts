import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const repoRoot = join(import.meta.dir, "..");
const graph = JSON.parse(readFileSync(join(repoRoot, "docs", "bpms-program-dependency-graph.json"), "utf-8"));
const doc = readFileSync(join(repoRoot, "docs", "bpms-program-dependency-graph.md"), "utf-8");

describe("BPMS program dependency graph", () => {
  test("covers every issue in the #672-#751 program range", () => {
    const issues = graph.issue_dependencies as Record<string, unknown>;

    for (let issue = 672; issue <= 751; issue++) {
      expect(issues[String(issue)]).toBeDefined();
    }
  });

  test("capability issues define prerequisites and downstream blockers", () => {
    const issues = graph.issue_dependencies as Record<string, { depends_on: unknown[]; blocks: unknown[] }>;

    for (let issue = 673; issue <= 686; issue++) {
      expect(issues[String(issue)].depends_on.length).toBeGreaterThan(0);
      expect(issues[String(issue)].blocks.length).toBeGreaterThan(0);
    }
  });

  test("milestones carry DoD and role ownership", () => {
    for (const milestone of graph.milestones) {
      expect(milestone.definition_of_done.length).toBeGreaterThanOrEqual(3);
      expect(milestone.implementation_owner).toBeTruthy();
      expect(milestone.review_owner).toBe("Shikadai");
      expect(milestone.release_owner).toBe("Naruto");
    }
  });

  test("Action Spine extraction remains blocked behind stable semantics", () => {
    expect(graph.extraction_gate.issue).toBe(618);
    expect(graph.extraction_gate.status).toBe("blocked");
    expect(graph.extraction_gate.blocked_until).toEqual([684, 685, 741, 742, 743, 744]);
    expect(graph.issue_dependencies["684"].blocks).toContain(618);
    expect(graph.issue_dependencies["685"].blocks).toContain(618);
  });

  test("human runbook includes critical path, parallel workstreams, and ownership", () => {
    expect(doc).toContain("Critical Path");
    expect(doc).toContain("Parallel Workstreams");
    expect(doc).toContain("Role Ownership");
    expect(doc).toContain("Developer -> Reviewer");
  });
});
