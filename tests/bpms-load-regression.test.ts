import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  evaluateBpmsObservation,
  loadBpmsLoadCatalog,
  loadBpmsObservation,
  loadResourceBudgetContract,
  validateBpmsLoadCatalog,
  writeBpmsRegressionReport,
  type BpmsLoadObservation,
} from "../src/bpms-load-regression";

describe("BPMS load regression suite", () => {
  test("profiles cover CI, release-gate staging, and eight-hour staging soak", () => {
    const catalog = loadBpmsLoadCatalog();
    const budgets = loadResourceBudgetContract();
    const errors = validateBpmsLoadCatalog(catalog, budgets);

    expect(errors).toEqual([]);
    expect(catalog.release_gate.required_profiles).toEqual(["ci-bpms-regression", "release-gate-staging"]);
    expect(catalog.release_gate.required_report).toBe("bpms-load-regression-report.json");

    const soak = catalog.profiles.find(profile => profile.id === "staging-soak-8h");
    expect(soak?.budget_profile).toBe("staging-core");
    expect(soak?.duration_sec).toBeGreaterThanOrEqual(8 * 60 * 60);
    expect(soak?.workload.telegram_activation_chains).toBeGreaterThan(0);
    expect(soak?.workload.outbox_retry_attempts).toBeGreaterThan(0);
    expect(soak?.workload.retention_cycles).toBeGreaterThan(0);
  });

  test("resource thresholds are bounded by the canonical resource budget contract", () => {
    const catalog = loadBpmsLoadCatalog();
    const budgets = loadResourceBudgetContract();

    for (const profile of catalog.profiles) {
      const budget = budgets.budget_profiles[profile.budget_profile];
      expect(profile.thresholds.process_rss_peak_mib).toBeLessThanOrEqual(budget.memory_max_mib);
      expect(profile.thresholds.cpu_sustained_percent).toBeLessThanOrEqual(budget.cpu_quota_percent);
      expect(profile.thresholds.cpu_sustained_percent).toBeLessThanOrEqual(budget.scale_out_at?.sustained_cpu_percent ?? budget.cpu_quota_percent);
    }
  });

  test("passing observations generate a release-gate report", () => {
    const catalog = loadBpmsLoadCatalog();
    const observation = loadBpmsObservation("tests/fixtures/bpms-load/ci-passing.json");
    const report = evaluateBpmsObservation(catalog, observation, "2026-05-18T01:00:00.000Z");

    expect(report.status).toBe("pass");
    expect(report.profile_id).toBe("ci-bpms-regression");
    expect(report.release_gate_attachment).toBe("bpms-load-regression-report.json");
    expect(report.checks.every(check => check.status === "pass")).toBe(true);

    const dir = mkdtempSync(join(tmpdir(), "bpms-load-report-"));
    const path = join(dir, "bpms-load-regression-report.json");
    writeBpmsRegressionReport(path, report);
    const persisted = JSON.parse(readFileSync(path, "utf-8"));
    expect(persisted.status).toBe("pass");
    expect(persisted.checks.length).toBe(report.checks.length);
  });

  test("observations fail on Redis command rate and memory growth regressions", () => {
    const catalog = loadBpmsLoadCatalog();
    const base = loadBpmsObservation("tests/fixtures/bpms-load/ci-passing.json");
    const observation: BpmsLoadObservation = {
      ...base,
      run_id: "fixture-ci-fail",
      metrics: {
        ...base.metrics,
        redis_command_rate_per_sec: 2501,
        redis_memory_growth_mib: 65,
      },
    };

    const report = evaluateBpmsObservation(catalog, observation);
    expect(report.status).toBe("fail");
    expect(report.checks.filter(check => check.status === "fail").map(check => check.name).sort()).toEqual([
      "metrics.redis_command_rate_per_sec",
      "metrics.redis_memory_growth_mib",
    ]);
  });
});
