import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const repoRoot = join(import.meta.dir, "..");

function read(path: string): string {
  return readFileSync(join(repoRoot, path), "utf-8");
}

function loadContract(): any {
  return JSON.parse(read("docs/workflow-engine-preflight-tiers.json"));
}

describe("Workflow Engine preflight tiers", () => {
  test("defines explicit tiers for #749 acceptance scope", () => {
    const contract = loadContract();
    const tiers = new Map(contract.tiers.map((tier: any) => [tier.id, tier]));

    expect(contract.updated_for_issue).toBe(749);
    expect(contract.parent_issue).toBe(686);
    expect(contract.release_policy).toBe("docs/release-policy.md");
    expect(contract.staging_contract).toBe("docs/staging-environment.json");
    expect([...tiers.keys()].sort()).toEqual([
      "browser-e2e",
      "fast-local",
      "healthcheck",
      "isolated-integration",
      "pg-verify",
      "production-smoke",
      "specialist-qa",
      "staging-core",
    ]);

    expect((tiers.get("fast-local") as any).commands.join("\n")).toContain("tests/eepc-state-machine-regression.test.ts");
    expect((tiers.get("isolated-integration") as any).commands).toContain("scripts/preflight-portable.sh");
    expect((tiers.get("browser-e2e") as any).commands.join("\n")).toContain("playwright");
    expect((tiers.get("production-smoke") as any).commands).toContain("scripts/preflight.sh");
    expect((tiers.get("pg-verify") as any).commands.join("\n")).toContain("scripts/pg-verify.ts");
    expect((tiers.get("healthcheck") as any).commands.join("\n")).toContain("scripts/healthcheck-system.py");
  });

  test("keeps production-only checks out of portable tiers", () => {
    const contract = loadContract();
    const portableTierIds = ["fast-local", "isolated-integration", "browser-e2e", "staging-core"];
    const tiers = new Map(contract.tiers.map((tier: any) => [tier.id, tier]));

    for (const id of portableTierIds) {
      const tier = tiers.get(id) as any;
      expect(tier.production_only).toBe(false);
      expect(tier.commands.join("\n")).not.toContain("KONOHA_SERVICE_PROFILE=prod-core python3 scripts/healthcheck-system.py");
      expect(tier.commands.join("\n")).not.toContain("bun run scripts/pg-verify.ts");
    }

    expect((tiers.get("production-smoke") as any).production_only).toBe(true);
  });

  test("requires M1 storage isolation and staging evidence", () => {
    const contract = loadContract();
    const evidence = contract.m1_isolation_evidence.join("\n");
    const staging = contract.tiers.find((tier: any) => tier.id === "staging-core");
    const pg = contract.tiers.find((tier: any) => tier.id === "pg-verify");

    expect(evidence).toContain("tests/test-storage-guardrails.test.ts");
    expect(evidence).toContain("tests/redis-test-isolation-contract.test.ts");
    expect(evidence).toContain("tests/pg-test-isolation-contract.test.ts");
    expect(evidence).toContain("tests/test-factory-namespace.test.ts");
    expect(evidence).toContain("tests/staging-environment.test.ts");
    expect(staging.requires_staging).toBe(true);
    expect(staging.commands.join("\n")).toContain("scripts/staging-smoke.sh --dry-run");
    expect(staging.commands.join("\n")).toContain("release-gate-staging");
    expect(pg.blockers).toContain("onlyInRedis > 0");
    expect(pg.warnings).toContain("onlyInPG bloat when onlyInRedis=0");
  });

  test("documentation and release policy link to tier contract", () => {
    const runbook = read("docs/workflow-engine-preflight-tiers.md");
    const workflowEngine = read("docs/workflow-engine.md");
    const releasePolicy = read("docs/release-policy.md");
    const testing = read("docs/testing.md");
    const graph = read("docs/bpms-program-dependency-graph.md");
    const preflightPortable = read("scripts/preflight-portable.sh");
    const preflight = read("scripts/preflight.sh");

    expect(runbook).toContain("docs/workflow-engine-preflight-tiers.json");
    expect(workflowEngine).toContain("docs/workflow-engine-preflight-tiers.md");
    expect(releasePolicy).toContain("docs/workflow-engine-preflight-tiers.md");
    expect(testing).toContain("docs/workflow-engine-preflight-tiers.md");
    expect(graph).toContain("docs/workflow-engine-preflight-tiers.json");
    expect(preflightPortable).toContain("tests/workflow-engine-preflight-tiers.test.ts");
    expect(preflight).toContain("tests/workflow-engine-preflight-tiers.test.ts");
  });
});
