import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const repoRoot = join(import.meta.dir, "..");

function read(path: string): string {
  return readFileSync(join(repoRoot, path), "utf-8");
}

function readJson(path: string): any {
  return JSON.parse(read(path));
}

describe("Workflow Engine release gate", () => {
  test("defines #686 as a release gate without claiming production release", () => {
    const gate = readJson("docs/workflow-engine-release-gate.json");

    expect(gate.schema_version).toBe(1);
    expect(gate.updated_for_issue).toBe(686);
    expect(gate.status).toBe("ready_for_release_gate_review");
    expect(gate.source_of_truth).toBe("docs/workflow-engine-release-gate.md");
    expect(gate.release_decision.issue_686_can_close_after_review).toBe(true);
    expect(gate.release_decision.production_release_claimed_by_this_commit).toBe(false);
    expect(gate.release_decision.normal_production_release_requires_owner_approval).toBe(true);
    expect(gate.release_decision.emergency_bypass_allowed_without_owner_acceptance).toBe(false);
    expect(gate.release_decision.package_extraction_618_unblocked_after_686).toBe(false);
  });

  test("inherits the accepted release, preflight, rollback, checklist, and golden-path contracts", () => {
    const gate = readJson("docs/workflow-engine-release-gate.json");

    expect(gate.inherits).toEqual([
      "docs/release-policy.md",
      "docs/workflow-engine-preflight-tiers.md",
      "docs/workflow-runtime-rollback-recovery.md",
      "docs/workflow-constructor-runtime-release-checklist.md",
      "docs/golden-path-acceptance-closure-report.json",
    ]);

    for (const file of gate.inherits) {
      expect(existsSync(join(repoRoot, file)), `${file} should exist`).toBe(true);
    }
  });

  test("records accepted parent evidence from architecture through golden path", () => {
    const gate = readJson("docs/workflow-engine-release-gate.json");
    const evidence = new Map(gate.accepted_parent_evidence.map((entry: any) => [entry.issue, entry]));

    expect([...evidence.keys()]).toEqual([672, 675, 678, 679, 680, 681, 683, 684, 685]);
    for (const entry of evidence.values()) {
      expect((entry as any).status).toBe("accepted");
      expect((entry as any).evidence.length).toBeGreaterThan(0);
      for (const file of (entry as any).evidence) {
        expect(existsSync(join(repoRoot, file)), `${file} should exist`).toBe(true);
      }
    }

    expect((evidence.get(685) as any).evidence).toContain("docs/golden-path-acceptance-closure-report.json");
    expect((evidence.get(684) as any).evidence).toContain("docs/action-spine-extraction-closure-report.json");
    expect((evidence.get(683) as any).evidence).toContain("docs/pg-read-consistency-closure-report.json");
  });

  test("separates blockers from warnings with storage, health, staging, Action Spine, and reviewer gates", () => {
    const gate = readJson("docs/workflow-engine-release-gate.json");
    const required = new Map(gate.required_release_gates.map((entry: any) => [entry.id, entry]));
    const warnings = new Map(gate.warnings.map((entry: any) => [entry.id, entry]));

    expect([...required.keys()].sort()).toEqual([
      "action-spine-security",
      "golden-path",
      "healthcheck",
      "pg-verify",
      "portable-ci",
      "production-smoke",
      "reviewer-acceptance",
      "rollback-recovery",
      "staging-core",
    ]);

    expect((required.get("pg-verify") as any).blocks_release_when).toContain("onlyInRedis > 0");
    expect((required.get("healthcheck") as any).blocks_release_when).toContain("required prod-core service");
    expect((required.get("action-spine-security") as any).commands.join("\n")).toContain("action-surface-report.ts --check");
    expect((required.get("action-spine-security") as any).commands.join("\n")).toContain("check-route-auth-policy.py");
    expect((required.get("golden-path") as any).commands.join("\n")).toContain("AssistantWidgetGoldenPath-747.spec.ts");
    expect((required.get("staging-core") as any).blocks_release_when).toContain("production connectors");
    expect((required.get("rollback-recovery") as any).source).toBe("docs/workflow-runtime-rollback-recovery.json");

    expect((warnings.get("only-in-pg-bloat") as any).condition).toContain("onlyInPG");
    expect((warnings.get("only-in-pg-bloat") as any).release_effect).toContain("not a release blocker");
    expect((warnings.get("optional-services-disabled") as any).release_effect).toContain("warning");
  });

  test("keeps #812 terminal-case behavior as an explicit gate", () => {
    const gate = readJson("docs/workflow-engine-release-gate.json");
    const terminal = gate.terminal_case_gate;
    const markdown = read("docs/workflow-engine-release-gate.md");

    expect(terminal.issue).toBe(812);
    expect(terminal.status).toBe("open_paused_by_yegor");
    expect(terminal.class).toBe("blocker_for_terminal_routing_regressions");
    expect(terminal.rule).toContain("terminal cases");
    expect(terminal.rule).toContain("dispatch effects");
    expect(terminal.release_policy).toContain("does not close, unpause, or waive #812");
    expect(markdown).toContain("#812 remains open and paused by Yegor");
    expect(markdown).toContain("does not waive it");
  });

  test("covers rollback scenarios required by #686 acceptance", () => {
    const gate = readJson("docs/workflow-engine-release-gate.json");
    const scenarios = new Map(gate.rollback_and_recovery.map((entry: any) => [entry.scenario, entry]));

    expect([...scenarios.keys()]).toEqual([
      "failed deploy or partial deploy",
      "stuck work item or running case",
      "failed runtime effect",
      "PG/Redis divergence",
    ]);
    expect((scenarios.get("failed deploy or partial deploy") as any).runbook).toContain("partial-deploy-or-failed-deploy");
    expect((scenarios.get("stuck work item or running case") as any).required_evidence.join("\n")).toContain("#812 terminal-case check");
    expect((scenarios.get("failed runtime effect") as any).required_evidence.join("\n")).toContain("audit-linked recovery receipt");
    expect((scenarios.get("PG/Redis divergence") as any).required_evidence.join("\n")).toContain("onlyInRedis blocker");
  });

  test("release policy, checklist, docs, and preflight scripts reference the #686 gate", () => {
    const releasePolicy = read("docs/release-policy.md");
    const checklistMd = read("docs/workflow-constructor-runtime-release-checklist.md");
    const checklistJson = readJson("docs/workflow-constructor-runtime-release-checklist.json");
    const preflightPortable = read("scripts/preflight-portable.sh");
    const preflight = read("scripts/preflight.sh");

    expect(releasePolicy).toContain("docs/workflow-engine-release-gate.md");
    expect(checklistMd).toContain("docs/workflow-engine-release-gate.md");
    expect(checklistJson.workflow_engine_release_gate).toBe("docs/workflow-engine-release-gate.json");
    expect(preflightPortable).toContain("tests/workflow-engine-release-gate.test.ts");
    expect(preflight).toContain("tests/workflow-engine-release-gate.test.ts");
  });

  test("mandatory commands include runbook, golden path, browser, action-surface, route-auth, typecheck, and diff checks", () => {
    const gate = readJson("docs/workflow-engine-release-gate.json");
    const commands = gate.mandatory_review_commands.join("\n");

    expect(commands).toContain("json.tool docs/workflow-engine-release-gate.json");
    expect(commands).toContain("tests/workflow-engine-release-gate.test.ts");
    expect(commands).toContain("tests/workflow-runtime-rollback-recovery.test.ts");
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
