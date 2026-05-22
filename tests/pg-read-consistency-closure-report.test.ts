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

describe("Redis/PostgreSQL consistency parent closure report", () => {
  test("maps #683 acceptance criteria to closed child evidence", () => {
    const report = readJson("docs/pg-read-consistency-closure-report.json");
    const coverage = new Map(report.acceptance_coverage.map((item: any) => [item.criterion, item]));

    expect(report.updated_for_issue).toBe(683);
    expect(report.status).toBe("ready_for_parent_review");
    expect(report.accepted_child_issues).toEqual([737, 738, 739, 740, 754]);
    expect(coverage.size).toBe(6);
    for (const item of report.acceptance_coverage) {
      expect(item.status).toBe("covered");
      expect(item.evidence.length).toBeGreaterThanOrEqual(2);
    }
    expect((coverage.get("PG_READ readiness report preserves onlyInRedis and PG-only retention blockers") as any).stable_blockers).toEqual([
      "ONLY_IN_REDIS",
      "PG_ONLY_MANUAL_REVIEW",
      "PG_ONLY_RETENTION_REQUIRED",
    ]);
  });

  test("keeps onlyInRedis as a blocker and PG-only rows behind retention review", () => {
    const report = readJson("docs/pg-read-consistency-closure-report.json");

    expect(report.target_invariant).toContain("onlyInRedis is a cutover blocker");
    expect(report.gate_policy.only_in_redis).toMatchObject({
      severity: "blocker",
      allowed_waiver: false,
    });
    expect(report.gate_policy.only_in_redis.applies_to).toEqual([
      "PG_READ rollout",
      "release gate",
      "retention cleanup",
    ]);
    expect(report.gate_policy.only_in_pg).toMatchObject({
      severity: "retention_gate",
      destructive_cleanup_from_pg_verify_alone: false,
    });
  });

  test("links persistence docs to SOT split, readiness, retention, and entity flags", () => {
    const persistence = read("docs/persistence-sot.md");
    const roadmap = read("docs/pg-read-cutover-roadmap.md");
    const configuration = read("docs/configuration.md");
    const closure = read("docs/pg-read-consistency-closure-report.md");

    for (const expected of [
      "onlyInRedis > 0",
      "Retention reporting",
      "PG_READ readiness reporting",
      "pg_primary",
      "PG_READ_ENTITIES",
      "PG_READ=true",
      "Agent presence is the exception",
    ]) {
      expect(persistence).toContain(expected);
    }
    expect(roadmap).toContain("pg-only-retention-report.ts");
    expect(roadmap).toContain("pg-read-readiness-report.ts");
    expect(configuration).toContain("PG_READ_ENTITIES");
    expect(configuration).toContain("PG_READ_CASES");
    expect(closure).toContain("Issue #683");
    expect(closure).toContain("#737, #738, #739, #740, and #754");
  });

  test("source surfaces keep PG_READ staged and retention-gated", () => {
    const flags = read("src/storage/pg-read-flags.ts");
    const readiness = read("src/pg-read-readiness.ts");
    const retentionReport = read("src/retention/report.ts");
    const retentionPolicy = read("src/retention/runtime-policy.ts");
    const agentVerify = read("src/pg-verify-agents.ts");

    expect(flags).toContain("PG_READ_ENTITIES");
    expect(flags).toContain("PG_READ_WORK_ITEMS");
    expect(readiness).toContain("ONLY_IN_REDIS");
    expect(readiness).toContain("PG_ONLY_RETENTION_REQUIRED");
    expect(readiness).toContain("pg_primary");
    expect(retentionReport).toContain("safe_cleanup_candidate");
    expect(retentionReport).toContain("manual_review");
    expect(retentionPolicy).toContain("block_when_redis_only_rows");
    expect(agentVerify).toContain("ignoreOnlyInPgBloat");
    expect(agentVerify).toContain("managed_agent_definitions");
  });

  test("declares review commands for PG verify, readiness, retention, action surface, auth, and typecheck checks", () => {
    const report = readJson("docs/pg-read-consistency-closure-report.json");

    expect(report.review_commands.some((command: string) => command.includes("tests/pg-read-consistency-closure-report.test.ts"))).toBe(true);
    expect(report.review_commands.some((command: string) => command.includes("tests/pg-verify-agent-contract.test.ts"))).toBe(true);
    expect(report.review_commands.some((command: string) => command.includes("tests/pg-read-readiness-report.test.ts"))).toBe(true);
    expect(report.review_commands).toContain("PATH=/home/ubuntu/.bun/bin:$PATH bun run scripts/action-surface-report.ts --check");
    expect(report.review_commands).toContain("python3 scripts/check-route-auth-policy.py");
    expect(report.review_commands).toContain("PATH=/home/ubuntu/.bun/bin:$PATH bun run typecheck");
    expect(report.operator_commands).toContain("PATH=/home/ubuntu/.bun/bin:$PATH bun run scripts/pg-verify.ts");
    expect(report.closure_decision.parent_issue_can_close_after_review).toBe(true);
    expect(report.closure_decision.release_claim_unblocked).toBe(false);
  });
});
