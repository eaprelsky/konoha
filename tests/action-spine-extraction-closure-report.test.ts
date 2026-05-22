import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const repoRoot = join(import.meta.dir, "..");
const reportPath = join(repoRoot, "docs/action-spine-extraction-closure-report.json");

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf-8");
}

function readReport(): any {
  return JSON.parse(readFileSync(reportPath, "utf-8"));
}

describe("Action Spine extraction closure report", () => {
  test("reconciles accepted child issues without claiming package extraction", () => {
    const report = readReport();

    expect(report.schema_version).toBe(1);
    expect(report.updated_for_issue).toBe(684);
    expect(report.status).toBe("ready_for_parent_review");
    expect(report.parent_issue).toBe(684);
    expect(report.source_contract).toBe("docs/adr-005-action-spine-extraction.md");
    expect(report.accepted_child_issues.map((entry: any) => entry.issue)).toEqual([
      741,
      742,
      743,
      744,
    ]);
    expect(report.accepted_child_issues.every((entry: any) => entry.status === "accepted")).toBe(true);
    expect(report.gate_policy.package_extraction_allowed_now).toBe(false);
    expect(report.gate_policy.runtime_behavior_changed).toBe(false);
    expect(report.gate_policy.release_claim_unblocked).toBe(false);
    expect(report.closure_decision.parent_issue_can_close_after_review).toBe(true);
    expect(report.closure_decision.package_extraction_can_start).toBe(false);
    expect(report.closure_decision.remaining_external_gates).toEqual([618, 685, 686]);
  });

  test("all recorded evidence files exist and coverage is complete", () => {
    const report = readReport();
    const evidence = new Set<string>();

    for (const child of report.accepted_child_issues) {
      expect(child.evidence.length).toBeGreaterThan(0);
      for (const file of child.evidence) evidence.add(file);
    }
    for (const coverage of report.acceptance_coverage) {
      expect(coverage.status).toBe("covered");
      expect(coverage.evidence.length).toBeGreaterThan(0);
      for (const file of coverage.evidence) evidence.add(file);
    }

    for (const file of evidence) {
      expect(existsSync(join(repoRoot, file)), `${file} should exist`).toBe(true);
    }
  });

  test("generic core remains free of Konoha host vocabulary and runtime imports", () => {
    const coreSource = [
      readRepoFile("src/action-spine/core-types.ts"),
      readRepoFile("src/action-spine/ports.ts"),
    ].join("\n");

    for (const forbidden of [
      "../action-definitions",
      "../action-registry",
      "../action-policy",
      "workflow-loader",
      "runtime/",
      "Konoha",
      "workflow.deploy",
      "case.start",
      "role.create",
    ]) {
      expect(coreSource.includes(forbidden), `generic core contains ${forbidden}`).toBe(false);
    }

    const hostVocabulary = [
      readRepoFile("src/action-definitions.ts"),
      readRepoFile("src/action-registry.ts"),
      readRepoFile("src/action-policy.ts"),
    ].join("\n");
    expect(hostVocabulary).toContain("workflow.deploy");
    expect(hostVocabulary).toContain("case.start");
    expect(hostVocabulary).toContain("role.create");
    expect(hostVocabulary).toContain("KonohaActionScope");
  });

  test("ADR and spike docs reflect accepted gates and separate future checks", () => {
    const adr = readRepoFile("docs/adr-005-action-spine-extraction.md");
    const spike = readRepoFile("docs/action-spine-package-extraction-spike.md");
    const closure = readRepoFile("docs/action-spine-extraction-closure-report.md");

    for (const doc of [adr, spike, closure]) {
      expect(doc).toContain("#684");
      expect(doc).toContain("#685");
      expect(doc).toContain("#686");
      expect(doc).toContain("#618");
    }

    expect(adr).toContain("docs/action-spine-extraction-closure-report.md");
    expect(spike).toContain("docs/action-spine-extraction-closure-report.md");
    expect(adr).toContain("- [x] #684 accepted");
    expect(adr).toContain("- [x] #685 accepted");
    expect(adr).toContain("- [x] #686 accepted");
    expect(spike).toContain("- [x] #684 accepted");
    expect(spike).toContain("- [x] #685 accepted");
    expect(spike).toContain("- [x] #686 accepted");
    expect(adr).toContain("Remaining future extraction checks");
    expect(spike).toContain("Future checks before broader extraction or publishing");
    expect(`${adr}\n${spike}`).not.toContain("- [ ] #684 accepted");
    expect(`${adr}\n${spike}`).not.toContain("- [ ] #685 accepted");
    expect(`${adr}\n${spike}`).not.toContain("- [ ] #686 accepted");
    expect(`${adr}\n${spike}`).not.toContain("#685/#686 not accepted yet");
    expect(`${adr}\n${spike}`).not.toContain("Do not start #618 extraction while #685/#686 acceptance evidence is missing");
    expect(closure).toContain("did not move runtime");
    expect(`${adr}\n${spike}\n${closure}`).toContain("#812");
  });

  test("review commands preserve boundary, action surface, route auth, typecheck, and diff checks", () => {
    const report = readReport();
    const commands = report.review_commands.join("\n");

    expect(commands).toContain("tests/action-spine-extraction-closure-report.test.ts");
    expect(commands).toContain("tests/action-spine-boundary.test.ts");
    expect(commands).toContain("scripts/action-surface-report.ts --check");
    expect(commands).toContain("scripts/check-route-auth-policy.py");
    expect(commands).toContain("bun run typecheck");
    expect(commands).toContain("git diff --check");
  });
});
