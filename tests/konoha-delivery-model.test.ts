import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const repoRoot = join(import.meta.dir, "..");

function read(path: string): string {
  return readFileSync(join(repoRoot, path), "utf-8");
}

function loadModel(): any {
  return JSON.parse(read("docs/konoha-delivery-model.json"));
}

describe("Konoha architecture delivery model", () => {
  test("defines the #756 decision and source documents", () => {
    const model = loadModel();

    expect(model.schema_version).toBe(1);
    expect(model.updated_for_issue).toBe(756);
    expect(model.parent_issue).toBe(672);
    expect(model.recommended_model).toBe("developer_reviewer_default_with_explicit_specialist_escalation");
    expect(model.source_documents).toContain("docs/sdd-worker-pool.md");
    expect(model.source_documents).toContain("docs/staging-environment.md");
    expect(model.source_documents).toContain("docs/release-policy.md");
    expect(model.source_documents).toContain("docs/workflow-engine-preflight-tiers.md");
    expect(model.source_documents).toContain("docs/workflow-runtime-rollback-recovery.md");
    expect(model.source_documents).toContain("docs/workflow-constructor-runtime-release-checklist.md");
  });

  test("keeps the default path two-role and specialists explicit", () => {
    const model = loadModel();
    const roles = new Map(model.roles.map((role: any) => [role.id, role]));

    expect((roles.get("kakashi") as any).responsibility).toBe("Developer implementation");
    expect((roles.get("shikadai") as any).responsibility).toBe("Reviewer and architecture gate");
    expect((roles.get("shino") as any).default_use).toContain("only when Shikadai requests");
    expect((roles.get("hinata") as any).default_use).toContain("reviewer-approved browser/TestBench plan");
    expect((roles.get("ibiki") as any).default_use).toContain("security-sensitive review");
    expect((roles.get("naruto") as any).must_not_do).toContain("approve own implementation");
    expect(model.ceremony_to_avoid).toContain("mandatory Shino/Hinata pass for every Developer fix");
    expect(model.ceremony_to_avoid).toContain("starting optional workers without reviewer request");
  });

  test("separates human decisions from automated checks", () => {
    const model = loadModel();
    const human = model.human_operator_decisions.join("\n");
    const automated = model.automated_checks_preferred.join("\n");

    expect(human).toContain("normal production release approval");
    expect(human).toContain("emergency bypass risk acceptance");
    expect(human).toContain("destructive data cleanup approval");
    expect(human).toContain("unpausing paused P0 work such as #812");
    expect(automated).toContain("scripts/preflight-portable.sh");
    expect(automated).toContain("scripts/action-surface-report.ts --check");
    expect(automated).toContain("python3 scripts/check-route-auth-policy.py");
    expect(automated).toContain("bun run scripts/pg-verify.ts");
    expect(automated).toContain("scripts/staging-smoke.sh --dry-run");
  });

  test("defines P0/P1 gates, labels, bus handoffs, and staging signoff", () => {
    const model = loadModel();
    const p0p1 = model.minimum_gates.find((gate: any) => gate.scope === "p0-p1-workflow-engine");
    const release = model.minimum_gates.find((gate: any) => gate.scope === "release-or-production-readiness");

    expect(p0p1.required.join("\n")).toContain("Shikadai architecture review before closure");
    expect(p0p1.required.join("\n")).toContain("#812 terminal-case rule review");
    expect(p0p1.optional_when_requested).toEqual(["Shino test-plan escalation", "Hinata browser/TestBench run", "Ibiki security/audit review"]);
    expect(release.required.join("\n")).toContain("docs/workflow-constructor-runtime-release-checklist.md checklist class ids");
    expect(model.github_labels.developer_intake).toEqual(["state:ready-for-dev", "agent:kakashi"]);
    expect(model.github_labels.review_handoff).toEqual(["state:ready-for-review", "agent:shikadai"]);
    expect(model.github_labels.optional_specialist_qa).toEqual(["state:ready-for-test", "agent:shino"]);
    expect(model.github_labels.legacy_not_gates).toContain("needs-testing");
    expect(model.konoha_bus_handoffs.ready_for_review).toContain("Ready for review: issue #<n>");
    expect(model.staging_qa_signoff.default_command).toBe("scripts/staging-smoke.sh --dry-run");
    expect(model.staging_qa_signoff.production_separation).toContain("Redis DB 2");
  });

  test("documents review blocking, redispatch, and rollback behavior", () => {
    const model = loadModel();
    const rollback = model.rollback_and_redispatch;

    expect(rollback.review_blocker).toContain("state:blocked + agent:kakashi");
    expect(rollback.stale_duplicate_delivery).toContain("Check GitHub labels/state");
    expect(rollback.worktree_tail).toContain("commit only the current issue scope");
    expect(rollback.runtime_rollback).toContain("docs/workflow-runtime-rollback-recovery.md");
    expect(rollback.worker_pool_rollback).toContain("scripts/sdd-worker-pool.py rollback");
    expect(model.quality_signals).toContain("staging-core smoke or accepted waiver");
    expect(model.quality_signals).toContain("GitHub parent receipt");
  });

  test("docs and preflight scripts link the model", () => {
    const markdown = read("docs/konoha-delivery-model.md");
    const sddPool = read("docs/sdd-worker-pool.md");
    const agentOps = read("docs/agent-operations-runbook.md");
    const github = read("docs/github-sdd-connector.md");
    const release = read("docs/release-policy.md");
    const checklist = read("docs/workflow-constructor-runtime-release-checklist.md");
    const preflightPortable = read("scripts/preflight-portable.sh");
    const preflight = read("scripts/preflight.sh");

    expect(markdown).toContain("docs/konoha-delivery-model.json");
    expect(markdown).toContain("Developer Kakashi -> Reviewer Shikadai");
    expect(markdown).toContain("state:ready-for-test");
    expect(markdown).toContain("docs/staging-environment.md");
    expect(sddPool).toContain("docs/konoha-delivery-model.md");
    expect(agentOps).toContain("docs/konoha-delivery-model.md");
    expect(github).toContain("docs/konoha-delivery-model.md");
    expect(release).toContain("docs/konoha-delivery-model.md");
    expect(checklist).toContain("docs/konoha-delivery-model.md");
    expect(preflightPortable).toContain("tests/konoha-delivery-model.test.ts");
    expect(preflight).toContain("tests/konoha-delivery-model.test.ts");
  });
});
