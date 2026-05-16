import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const repoRoot = join(import.meta.dir, "..");
const graph = JSON.parse(readFileSync(join(repoRoot, "docs", "bpms-program-dependency-graph.json"), "utf-8"));
const doc = readFileSync(join(repoRoot, "docs", "bpms-program-dependency-graph.md"), "utf-8");

type Milestone = {
  id: string;
  issues: number[];
  follow_up_issues?: number[];
};

type IssueDependency = {
  milestone: string;
  depends_on: Array<number | string>;
  blocks: Array<number | string>;
};

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

  test("issue dependencies do not point to future milestones", () => {
    const milestones = graph.milestones as Milestone[];
    const milestoneOrder = new Map(milestones.map((milestone, index) => [milestone.id, index]));
    const issueMilestones = new Map<number, string>();

    for (const milestone of milestones) {
      for (const issue of [...milestone.issues, ...(milestone.follow_up_issues ?? [])]) {
        expect(issueMilestones.has(issue)).toBe(false);
        issueMilestones.set(issue, milestone.id);
      }
    }

    expect(issueMilestones.get(757)).toBe("M0");
    expect(issueMilestones.get(787)).toBe("M5");

    const issues = graph.issue_dependencies as Record<string, IssueDependency>;
    for (const [issue, dependency] of Object.entries(issues)) {
      if (dependency.milestone === "program") {
        continue;
      }

      const currentOrder = milestoneOrder.get(dependency.milestone);
      expect(currentOrder).toBeDefined();
      expect(issueMilestones.get(Number(issue))).toBe(dependency.milestone);

      for (const prerequisite of dependency.depends_on) {
        if (typeof prerequisite !== "number") {
          continue;
        }

        const prerequisiteMilestone = issueMilestones.get(prerequisite);
        expect(prerequisiteMilestone).toBeDefined();
        expect(milestoneOrder.get(prerequisiteMilestone!)).toBeLessThanOrEqual(currentOrder!);
      }
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
