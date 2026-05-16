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

    expect(unit.Environment).toContain("TESTBENCH_POOL_SIZE=3");
    expect(unit.Environment).toContain("TESTBENCH_MAX_POOL_SIZE=3");
    expect(unit.MemoryMax).toContain(raw.systemd.units["konoha-testbench.service"].memory_max);
    expect(unit.CPUQuota).toContain(raw.systemd.units["konoha-testbench.service"].cpu_quota);
    expect(unit.TasksMax).toContain("2048");
    expect(pool).toContain("Math.min(requestedPoolSize, MAX_POOL_SIZE)");
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
