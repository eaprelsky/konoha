import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const repoRoot = join(import.meta.dir, "..");

function read(path: string): string {
  return readFileSync(join(repoRoot, path), "utf-8");
}

function loadChecklist(): any {
  return JSON.parse(read("docs/workflow-constructor-runtime-release-checklist.json"));
}

describe("Workflow constructor/runtime release checklist", () => {
  test("defines the #751 contract and inherited release gates", () => {
    const checklist = loadChecklist();

    expect(checklist.updated_for_issue).toBe(751);
    expect(checklist.parent_issue).toBe(686);
    expect(checklist.release_policy).toBe("docs/release-policy.md");
    expect(checklist.preflight_tiers).toBe("docs/workflow-engine-preflight-tiers.md");
    expect(checklist.runtime_recovery_runbook).toBe("docs/workflow-runtime-rollback-recovery.md");
    expect(checklist.security_boundary).toBe("docs/workflow-security-boundary.md");
    expect(checklist.action_surface).toBe("docs/action-surface.json");
    expect(checklist.staging_contract).toBe("docs/staging-environment.json");

    expect(checklist.m1_isolation_evidence).toContain("tests/test-storage-guardrails.test.ts");
    expect(checklist.m1_isolation_evidence).toContain("tests/redis-test-isolation-contract.test.ts");
    expect(checklist.m1_isolation_evidence).toContain("tests/pg-test-isolation-contract.test.ts");
    expect(checklist.m1_isolation_evidence).toContain("tests/staging-environment.test.ts");
  });

  test("covers constructor/runtime change classes and reviewer questions", () => {
    const checklist = loadChecklist();
    const classes = new Map(checklist.change_classes.map((entry: any) => [entry.id, entry]));
    const reviewerChecks = checklist.reviewer_checklist.map((entry: any) => entry.id).sort();

    expect([...classes.keys()].sort()).toEqual([
      "action-spine-mutation",
      "connector-outbox-effects",
      "constructor-editor",
      "deployment-subscription",
      "docs-only-exception",
      "storage-pg-shadow",
      "workflow-runtime",
    ]);

    expect(reviewerChecks).toEqual([
      "action-spine-security",
      "m1-isolation",
      "parent-receipt",
      "rollback-recovery",
      "stable-contract",
      "staging-core",
      "success-and-failure-tests",
      "terminal-case-rule",
    ]);

    expect((classes.get("constructor-editor") as any).required_contracts.join("\n")).toContain("Action Spine action");
    expect((classes.get("workflow-runtime") as any).required_contracts.join("\n")).toContain("#812 terminal-case rule");
    expect((classes.get("action-spine-mutation") as any).blockers.join("\n")).toContain("unknown or planned action");
    expect((classes.get("deployment-subscription") as any).required_artifacts.join("\n")).toContain("subscription diff");
    expect((classes.get("storage-pg-shadow") as any).blockers.join("\n")).toContain("onlyInRedis > 0");
    expect((classes.get("connector-outbox-effects") as any).blockers.join("\n")).toContain("idempotency key");
    expect((classes.get("docs-only-exception") as any).production_only).toContain("none unless release notes/tag are created");
  });

  test("keeps portable CI separate from production-only gates", () => {
    const checklist = loadChecklist();
    const portable = checklist.portable_ci_commands.join("\n");
    const production = checklist.production_only_commands.join("\n");

    expect(portable).toContain("scripts/preflight-portable.sh");
    expect(portable).toContain("tests/eepc-state-machine-regression.test.ts");
    expect(portable).toContain("scripts/action-surface-report.ts --check");
    expect(portable).toContain("scripts/check-route-auth-policy.py");
    expect(portable).not.toContain("scripts/preflight.sh");
    expect(portable).not.toContain("scripts/telegram-smoke.sh");
    expect(portable).not.toContain("KONOHA_SERVICE_PROFILE=prod-core python3 scripts/healthcheck-system.py");

    expect(production).toContain("scripts/preflight.sh");
    expect(production).toContain("KONOHA_SERVICE_PROFILE=prod-core python3 scripts/healthcheck-system.py");
    expect(production).toContain("bun run scripts/pg-verify.ts");
    expect(production).toContain("scripts/telegram-smoke.sh");
  });

  test("defines waiver wording, specialist escalation, and parent receipt", () => {
    const checklist = loadChecklist();
    const waiver = checklist.waiver_template;

    expect(waiver).toContain("Workflow constructor/runtime checklist waiver");
    expect(waiver).toContain("skipped gate");
    expect(waiver).toContain("replacement evidence");
    expect(waiver).toContain("rollback owner/command");
    expect(waiver).toContain("expires");

    expect(checklist.dispatch_escalation.default_path).toContain("Kakashi -> Reviewer Shikadai");
    expect(checklist.dispatch_escalation.specialist_qa).toContain("only when Shikadai explicitly requests");
    expect(checklist.dispatch_escalation.do_not_notify_by_default).toEqual(["Shino", "Hinata", "Guy"]);
    expect(checklist.parent_receipt.issue).toBe(686);
    expect(checklist.parent_receipt.fields).toContain("commit hash");
    expect(checklist.parent_receipt.fields).toContain("waivers");
  });

  test("docs and preflight scripts link the checklist", () => {
    const markdown = read("docs/workflow-constructor-runtime-release-checklist.md");
    const releasePolicy = read("docs/release-policy.md");
    const tiers = read("docs/workflow-engine-preflight-tiers.md");
    const workflowEngine = read("docs/workflow-engine.md");
    const graph = read("docs/bpms-program-dependency-graph.md");
    const preflightPortable = read("scripts/preflight-portable.sh");
    const preflight = read("scripts/preflight.sh");

    expect(markdown).toContain("docs/workflow-constructor-runtime-release-checklist.json");
    expect(markdown).toContain("docs/release-policy.md");
    expect(markdown).toContain("docs/workflow-engine-preflight-tiers.md");
    expect(markdown).toContain("docs/workflow-runtime-rollback-recovery.md");
    expect(markdown).toContain("#812 terminal-case rule");
    expect(releasePolicy).toContain("docs/workflow-constructor-runtime-release-checklist.md");
    expect(tiers).toContain("docs/workflow-constructor-runtime-release-checklist.md");
    expect(workflowEngine).toContain("docs/workflow-constructor-runtime-release-checklist.md");
    expect(graph).toContain("docs/workflow-constructor-runtime-release-checklist.md");
    expect(preflightPortable).toContain("tests/workflow-constructor-runtime-release-checklist.test.ts");
    expect(preflight).toContain("tests/workflow-constructor-runtime-release-checklist.test.ts");
  });
});
