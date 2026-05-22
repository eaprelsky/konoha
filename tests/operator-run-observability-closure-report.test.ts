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

describe("operator run observability parent closure report", () => {
  test("maps #681 acceptance criteria to closed child evidence", () => {
    const report = readJson("docs/operator-run-observability-closure-report.json");
    const coverage = new Map(report.acceptance_coverage.map((item: any) => [item.criterion, item]));

    expect(report.updated_for_issue).toBe(681);
    expect(report.status).toBe("ready_for_parent_review");
    expect(report.accepted_child_issues).toEqual([720, 729, 730, 731, 732]);
    expect(coverage.size).toBe(6);
    for (const item of report.acceptance_coverage) {
      expect(item.status).toBe("covered");
      expect(item.evidence.length).toBeGreaterThanOrEqual(2);
    }
    expect((coverage.get("case timeline records runtime effect state changes and deploy receipts") as any).stable_event_types).toContain("workflow.deploy.receipt");
    expect((coverage.get("runtime effect recovery has CLI/API retry, cancel, and dead-letter controls") as any).required_operations).toEqual([
      "inspect",
      "list",
      "retry",
      "cancel",
      "dead_letter",
    ]);
    expect((coverage.get("operational alerts flag stuck cases and failed/dead-letter effects with dedupe and recovery correlation") as any).stable_alert_kinds).toEqual([
      "stuck_case",
      "runtime_effect_failed",
    ]);
  });

  test("runtime outbox docs expose timeline, recovery, monitor, and audit contracts", () => {
    const markdown = read("docs/runtime-effect-outbox.md");
    const closure = read("docs/operator-run-observability-closure-report.md");

    for (const expected of [
      "runtime.effect.enqueued",
      "runtime.effect.dead_lettered",
      "runtime.effect.recovery",
      "workflow.deploy.receipt",
      "GET /runtime-effects",
      "POST /runtime-effects/:effect_id/retry",
      "POST /runtime-effects/:effect_id/dead-letter",
      "runtime_effect.<operation>",
      "result=error",
      "monitor.recovery_lane",
    ]) {
      expect(markdown).toContain(expected);
    }
    expect(closure).toContain("Issue #681");
    expect(closure).toContain("#720, #729, #730, #731, and #732");
    expect(closure).toContain("#812");
  });

  test("source surfaces preserve failed-state truth and operator-only recovery paths", () => {
    const routes = read("src/routes/runtime-effects.ts");
    const outbox = read("src/runtime-effect-outbox.ts");
    const timeline = read("src/runtime/timeline-events.ts");
    const monitor = read("frontend/src/pages/Monitor.tsx");
    const alerts = read("src/operational-alerts.ts");

    for (const expected of [
      "requireAdmin",
      "recoverRuntimeEffect",
      "RUNTIME_EFFECT_RECOVERY_FAILED",
    ]) {
      expect(routes).toContain(expected);
    }
    for (const expected of [
      "RuntimeEffectRecoveryError",
      "runtime_effect.",
      "reason",
      "actor",
    ]) {
      expect(outbox).toContain(expected);
    }
    expect(timeline).toContain("emitRuntimeEffectRecoveryTimelineEvent");
    expect(timeline).toContain("recovery_audit_entry_id");
    expect(monitor).toContain("filterOperatorRuntimeEffects");
    expect(monitor).toContain("filterOperatorWaits");
    expect(monitor).toContain("monitor.recovery_lane");
    expect(alerts).toContain("runtime_effect_failed");
    expect(alerts).toContain("dead_letter");
    expect(alerts).toContain("recovery_paths");
  });

  test("declares review commands for backend, frontend, action surface, auth, and typecheck checks", () => {
    const report = readJson("docs/operator-run-observability-closure-report.json");

    expect(report.review_commands.some((command: string) => command.includes("tests/operator-run-observability-closure-report.test.ts"))).toBe(true);
    expect(report.review_commands.some((command: string) => command.includes("tests/runtime-effect-recovery.test.ts"))).toBe(true);
    expect(report.review_commands.some((command: string) => command.includes("monitorOpsPanel operatorView"))).toBe(true);
    expect(report.review_commands).toContain("PATH=/home/ubuntu/.bun/bin:$PATH bun run scripts/action-surface-report.ts --check");
    expect(report.review_commands).toContain("python3 scripts/check-route-auth-policy.py");
    expect(report.review_commands).toContain("PATH=/home/ubuntu/.bun/bin:$PATH bun run typecheck");
    expect(report.closure_decision.parent_issue_can_close_after_review).toBe(true);
    expect(report.closure_decision.release_claim_unblocked).toBe(false);
  });
});
