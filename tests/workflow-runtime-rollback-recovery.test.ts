import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { validateEnvelope } from "../src/act-envelope";
import { dumpRegistry } from "../src/action-registry";

const repoRoot = join(import.meta.dir, "..");

function read(path: string): string {
  return readFileSync(join(repoRoot, path), "utf-8");
}

function loadRunbook(): any {
  return JSON.parse(read("docs/workflow-runtime-rollback-recovery.json"));
}

function extractActEnvelopes(text: string): any[] {
  return [...text.matchAll(/-d '({[^']*"action"[^']*})'/g)].map(match => JSON.parse(match[1]));
}

describe("Workflow runtime rollback and recovery runbook", () => {
  test("defines the #750 contract and runtime boundaries", () => {
    const runbook = loadRunbook();
    const boundaries = new Map(runbook.runtime_state_boundaries.map((boundary: any) => [boundary.id, boundary]));

    expect(runbook.updated_for_issue).toBe(750);
    expect(runbook.parent_issue).toBe(686);
    expect(runbook.release_policy).toBe("docs/release-policy.md");
    expect(runbook.preflight_tiers).toBe("docs/workflow-engine-preflight-tiers.md");
    expect(runbook.security_boundary).toBe("docs/workflow-security-boundary.md");
    expect(runbook.action_surface).toBe("docs/action-surface.json");

    expect([...boundaries.keys()].sort()).toEqual([
      "outbox_dispatch_effects",
      "postgres_shadow_state",
      "redis_active_state",
      "reminders",
      "running_cases",
      "subscriptions_event_waits",
      "work_items",
    ]);

    expect((boundaries.get("redis_active_state") as any).rollback_limit).toContain("Code rollback does not rewind");
    expect((boundaries.get("postgres_shadow_state") as any).rollback_limit).toContain("onlyInRedis is a blocker");
    expect((boundaries.get("outbox_dispatch_effects") as any).rollback_limit).toContain("cannot be unsent");
  });

  test("reflects the paused #812 terminal-case rule without changing issue state", () => {
    const runbook = loadRunbook();
    const rule = `${runbook.terminal_case_rule.status}\n${runbook.terminal_case_rule.rule}`;

    expect(runbook.terminal_case_rule.source_issue).toBe(812);
    expect(rule).toContain("paused by Yegor");
    expect(rule).toContain("do not unpause or close");
    expect(rule).toContain("terminal");
    expect(rule).toContain("must not receive new routed work");
    expect(rule).toContain("new event waits");
    expect(rule).toContain("subscription resumes");
  });

  test("covers required recovery scenarios with commands and evidence", () => {
    const runbook = loadRunbook();
    const scenarios = new Map(runbook.recovery_scenarios.map((scenario: any) => [scenario.id, scenario]));
    const required = [
      "bad-assistant-action",
      "duplicate-dispatch",
      "failed-connector",
      "failed-deploy",
      "invalid-workflow-update",
      "orphaned-waits-subscriptions",
      "partial-deploy",
      "pg-redis-divergence",
      "stuck-running-case",
    ];

    expect([...scenarios.keys()].sort()).toEqual(required);

    for (const id of required) {
      const scenario = scenarios.get(id) as any;
      expect(scenario.commands.length).toBeGreaterThan(0);
      expect(scenario.evidence.length).toBeGreaterThan(0);
      expect(scenario.blockers.length).toBeGreaterThan(0);
      expect(scenario.audit.length).toBeGreaterThan(20);
    }

    expect((scenarios.get("stuck-running-case") as any).commands.join("\n")).toContain("case.cancel");
    expect((scenarios.get("orphaned-waits-subscriptions") as any).commands.join("\n")).toContain("subscription.cancel");
    expect((scenarios.get("failed-connector") as any).commands.join("\n")).toContain("connector.send_message");
    expect((scenarios.get("partial-deploy") as any).commands.join("\n")).toContain("git revert <bad_commit>");
    expect((scenarios.get("pg-redis-divergence") as any).commands.join("\n")).toContain("scripts/reconcile-pg-bus.ts --dry-run");
  });

  test("keeps destructive production data changes behind an explicit gate", () => {
    const runbook = loadRunbook();
    const scenarioCommands = runbook.recovery_scenarios.flatMap((scenario: any) => scenario.commands).join("\n");
    const gate = runbook.destructive_data_gate;

    for (const forbidden of ["FLUSHDB", "FLUSHALL", "DROP DATABASE", "DROP SCHEMA public", "redis-cli --scan | xargs redis-cli del"]) {
      expect(scenarioCommands).not.toContain(forbidden);
      expect(gate.never_allowed_as_broad_recovery).toContain(forbidden);
    }

    for (const required of ["owner/operator acceptance", "Shikadai reviewer acceptance", "dry-run evidence", "Konoha bus audit message"]) {
      expect(gate.requires).toContain(required);
    }

    expect(gate.allowed_only_with_explicit_scope).toContain("retention.cleanup_apply");
    expect(gate.allowed_only_with_explicit_scope).toContain("case.delete");
  });

  test("keeps /act command examples aligned with the Action Spine registry", () => {
    const runbookJson = read("docs/workflow-runtime-rollback-recovery.json");
    const runbookMarkdown = read("docs/workflow-runtime-rollback-recovery.md");
    const registry = new Map(dumpRegistry().actions.map(action => [action.id, action]));
    const envelopes = [
      ...extractActEnvelopes(runbookJson),
      ...extractActEnvelopes(runbookMarkdown),
    ];

    expect(envelopes.length).toBeGreaterThan(10);

    for (const envelope of envelopes) {
      const errors = validateEnvelope(envelope);
      expect(errors).toEqual([]);

      const action = registry.get(envelope.action);
      expect(action).toBeDefined();
      expect(action?.implementation?.kind).not.toBe("planned");

      const allowedArgs = new Set((action?.args ?? []).map(arg => arg.name));
      const unknownArgs = Object.keys(envelope.args ?? {}).filter(arg => !allowedArgs.has(arg));
      expect(unknownArgs).toEqual([]);
    }
  });

  test("docs, release policy, and preflight scripts link the runbook", () => {
    const markdown = read("docs/workflow-runtime-rollback-recovery.md");
    const workflowEngine = read("docs/workflow-engine.md");
    const releasePolicy = read("docs/release-policy.md");
    const tiers = read("docs/workflow-engine-preflight-tiers.md");
    const graph = read("docs/bpms-program-dependency-graph.md");
    const preflightPortable = read("scripts/preflight-portable.sh");
    const preflight = read("scripts/preflight.sh");

    expect(markdown).toContain("docs/workflow-runtime-rollback-recovery.json");
    expect(markdown).toContain("#812 terminal-case rule");
    expect(workflowEngine).toContain("docs/workflow-runtime-rollback-recovery.md");
    expect(releasePolicy).toContain("docs/workflow-runtime-rollback-recovery.md");
    expect(tiers).toContain("docs/workflow-runtime-rollback-recovery.md");
    expect(graph).toContain("docs/workflow-runtime-rollback-recovery.md");
    expect(preflightPortable).toContain("tests/workflow-runtime-rollback-recovery.test.ts");
    expect(preflight).toContain("tests/workflow-runtime-rollback-recovery.test.ts");
  });
});
