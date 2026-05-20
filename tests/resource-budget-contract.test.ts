import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const repoRoot = join(import.meta.dir, "..");

function read(path: string): string {
  return readFileSync(join(repoRoot, path), "utf-8");
}

function parseUnit(path: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const line of read(path).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    (result[key] ??= []).push(rest.join("="));
  }
  return result;
}

describe("resource budget contract", () => {
  test("defines production, staging, QA, and CI budget profiles", () => {
    const raw = JSON.parse(read("docs/resource-budgets.json"));

    expect(raw.default_budget_profile).toBe("prod-core");
    expect(Object.keys(raw.budget_profiles).sort()).toEqual([
      "ci-test",
      "prod-core",
      "prod-full",
      "qa-on-demand",
      "staging-core",
    ]);
    expect(raw.budget_profiles["staging-core"].service_profile).toBe("staging-core");
    expect(raw.budget_profiles["ci-test"].testbench.default).toBe("disabled");
  });

  test("TestBench service and code enforce bounded Chromium pool", () => {
    const raw = JSON.parse(read("docs/resource-budgets.json"));
    const unit = parseUnit("konoha-testbench/konoha-testbench.service");
    const pool = read("konoha-testbench/src/pool.ts");

    expect(unit.Environment).toContain("TESTBENCH_MODE=on-demand");
    expect(unit.Environment).toContain("TESTBENCH_POOL_SIZE=1");
    expect(unit.Environment).toContain("TESTBENCH_MAX_POOL_SIZE=2");
    expect(unit.Environment).toContain("TESTBENCH_MAX_CONCURRENT_JOBS=2");
    expect(unit.Environment).toContain("TESTBENCH_SESSION_TTL_MS=300000");
    expect(unit.MemoryMax).toContain(raw.systemd.units["konoha-testbench.service"].memory_max);
    expect(unit.CPUQuota).toContain(raw.systemd.units["konoha-testbench.service"].cpu_quota);
    expect(unit.TasksMax).toContain("1024");
    expect(pool).toContain("Math.min(requestedPoolSize, MAX_POOL_SIZE)");
    expect(pool).toContain("TESTBENCH_MAX_CONCURRENT_JOBS");
    expect(pool).toContain("TESTBENCH_SESSION_TTL_MS");
  });

  test("committed slice files match the resource budget contract", () => {
    const raw = JSON.parse(read("docs/resource-budgets.json"));

    for (const [slice, expected] of Object.entries<any>(raw.systemd.slices)) {
      const unit = parseUnit(`systemd/${slice}`);
      expect(unit.MemoryHigh).toContain(expected.memory_high);
      expect(unit.MemoryMax).toContain(expected.memory_max);
      expect(unit.CPUQuota).toContain(expected.cpu_quota);
      expect(unit.TasksMax).toContain(expected.tasks_max);
    }
  });

  test("optional agent, MCP, and staging limits are committed", () => {
    const raw = JSON.parse(read("docs/resource-budgets.json"));
    const kiba = parseUnit("systemd/agent-kiba.service");
    const managed = parseUnit("systemd/agent-managed@.service");
    const staging = parseUnit("systemd/dropins/staging-core-konoha.conf");
    const mcpHeavy = raw.systemd.transient_scopes.mcp_heavy_pack_scope;

    expect(kiba.MemoryMax).toContain(raw.systemd.units["agent-kiba.service"].memory_max);
    expect(kiba.CPUQuota).toContain(raw.systemd.units["agent-kiba.service"].cpu_quota);
    expect(managed.MemoryMax).toContain(raw.systemd.units["agent-managed@.service"].memory_max);
    expect(managed.CPUQuota).toContain(raw.systemd.units["agent-managed@.service"].cpu_quota);
    expect(staging.MemoryMax).toContain(raw.systemd.profile_dropins["staging-core"]["konoha.service"].memory_max);
    expect(staging.CPUQuota).toContain(raw.systemd.profile_dropins["staging-core"]["konoha.service"].cpu_quota);
    expect(mcpHeavy).toMatchObject({
      slice: "konoha-qa.slice",
      memory_max: "384M",
      cpu_quota: "50%",
      tasks_max: "512",
    });
  });

  test("operator docs expose capacity report and scale-out policy", () => {
    const policy = read("docs/resource-budget-policy.md");
    const inventory = read("docs/resource-inventory.md");

    expect(policy).toContain("Scale-Out Policy");
    expect(policy).toContain("python3 scripts/resource-inventory.py --json --no-disk");
    expect(policy).toContain("redis-server.service");
    expect(policy).toContain("postgresql.service");
    expect(inventory).toContain("docs/resource-budgets.json");
  });
});
