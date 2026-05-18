import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  evaluateDataStoreDrill,
  loadDataStoreDrillContract,
  loadDataStoreDrillObservation,
  validateDataStoreDrillContract,
  writeDataStoreDrillReport,
  type DataStoreDrillObservation,
} from "../src/data-store-drill";

describe("Konoha data-store backup and restore drill", () => {
  test("contract defines RPO/RTO targets, owners, and required data stores", () => {
    const contract = loadDataStoreDrillContract();

    expect(validateDataStoreDrillContract(contract)).toEqual([]);
    expect(contract.global_targets).toMatchObject({
      rpo_minutes: 60,
      rto_minutes: 120,
      staging_restore_required: true,
      production_restore_requires_owner_approval: true,
    });
    expect(contract.owners).toMatchObject({
      primary: "platform_owner",
      secondary: "sdd_team_lead",
      reviewer: "shikadai",
      escalation: "naruto",
    });
    expect(contract.data_stores.map(store => store.id).sort()).toEqual([
      "operational-config",
      "postgres",
      "redis",
      "workflow-runtime",
    ]);
  });

  test("secret-bearing stores require encrypted backups and staging restore", () => {
    const contract = loadDataStoreDrillContract();

    for (const store of contract.data_stores) {
      expect(store.restore.target).toBe("staging");
      expect(store.backup.retention_days).toBeGreaterThanOrEqual(7);
      if (store.contains_secrets) {
        expect(store.backup.encryption_required).toBe(true);
      }
    }
  });

  test("staging restore checklist includes automated checks and release report", () => {
    const contract = loadDataStoreDrillContract();
    const steps = contract.staging_restore_drill.steps.join("\n");
    const verification = contract.staging_restore_drill.verification.join("\n");

    expect(contract.staging_restore_drill.required_environment).toBe("staging-core");
    expect(steps).toContain("Restore artifacts into staging-core only");
    expect(steps).toContain("Record RPO/RTO evidence");
    expect(verification).toContain("scripts/data-store-drill.ts --check");
    expect(verification).toContain("scripts/pg-verify.ts");
  });

  test("passing staging drill observations generate a release-gate report", () => {
    const contract = loadDataStoreDrillContract();
    const observation = loadDataStoreDrillObservation("tests/fixtures/data-store-drill/staging-passing.json");
    const report = evaluateDataStoreDrill(contract, observation, "2026-05-18T02:00:00.000Z");

    expect(report.status).toBe("pass");
    expect(report.environment).toBe("staging-core");
    expect(report.rpo_minutes).toBe(60);
    expect(report.rto_minutes).toBe(80);
    expect(report.checks.every(check => check.status === "pass")).toBe(true);

    const dir = mkdtempSync(join(tmpdir(), "data-store-drill-report-"));
    const path = join(dir, "konoha-data-store-drill-report.json");
    writeDataStoreDrillReport(path, report);
    const persisted = JSON.parse(readFileSync(path, "utf-8"));
    expect(persisted.status).toBe("pass");
    expect(persisted.checks.length).toBe(report.checks.length);
  });

  test("observations fail when Redis exceeds RPO or config restore is missing", () => {
    const contract = loadDataStoreDrillContract();
    const base = loadDataStoreDrillObservation("tests/fixtures/data-store-drill/staging-passing.json");
    const observation: DataStoreDrillObservation = {
      ...base,
      drill_id: "fixture-staging-drill-fail",
      artifacts: {
        ...base.artifacts,
        redis: { ...base.artifacts.redis, age_minutes: 61 },
        "operational-config": { ...base.artifacts["operational-config"], restored: false },
      },
    };

    const report = evaluateDataStoreDrill(contract, observation);
    expect(report.status).toBe("fail");
    expect(report.checks.filter(check => check.status === "fail").map(check => check.name).sort()).toEqual([
      "operational-config.restored",
      "redis.rpo",
    ]);
  });
});
