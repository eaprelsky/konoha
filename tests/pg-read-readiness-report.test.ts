import { describe, expect, test } from "bun:test";
import {
  buildPgReadReadinessReportFromRetentionReport,
  renderPgReadReadinessReportText,
} from "../src/pg-read-readiness";
import type { PgOnlyRetentionReport } from "../src/retention/report";

const GENERATED_AT = "2026-05-22T03:40:00.000Z";

function report(overrides: Partial<PgOnlyRetentionReport> = {}): PgOnlyRetentionReport {
  return {
    mode: "dry_run",
    generated_at: GENERATED_AT,
    hard_fail: false,
    entityCounts: [
      { entity: "roles", redisCount: 3, pgCount: 3, onlyInRedis: [], onlyInPg: 0 },
      { entity: "documents", redisCount: 2, pgCount: 2, onlyInRedis: [], onlyInPg: 0 },
      { entity: "workflows", redisCount: 10, pgCount: 10, onlyInRedis: [], onlyInPg: 0 },
      { entity: "cases", redisCount: 20, pgCount: 22, onlyInRedis: ["case-missing"], onlyInPg: 2 },
      { entity: "work_items", redisCount: 40, pgCount: 43, onlyInRedis: [], onlyInPg: 3 },
      { entity: "reminders", redisCount: 5, pgCount: 5, onlyInRedis: [], onlyInPg: 0 },
      { entity: "agents", redisCount: 4, pgCount: 5, onlyInRedis: [], onlyInPg: 1 },
    ],
    groups: [
      {
        entity: "cases",
        candidate: "review:historical_case",
        retention_class: "historical_case",
        disposition: "manual_review",
        safe_cleanup_candidate: false,
        reason: "historical case needs review",
        status: "done",
        process_prefix: "sales",
        id_prefix: "uuid",
        age_bucket: "30d+",
        would_delete_count: 2,
        sample_ids: ["case-pg-only"],
      },
      {
        entity: "work_items",
        candidate: "safe_candidate:old_completed_work_items",
        retention_class: "generated_test_artifact",
        disposition: "safe_cleanup_candidate",
        safe_cleanup_candidate: true,
        reason: "old generated work item",
        status: "done",
        process_prefix: "eepc",
        id_prefix: "uuid",
        age_bucket: "7-30d",
        would_delete_count: 3,
        sample_ids: ["wi-pg-only"],
      },
    ],
    ...overrides,
  };
}

describe("PG_READ readiness report", () => {
  test("marks entities ready only when Redis shadow is complete and PG-only rows are absent", () => {
    const readiness = buildPgReadReadinessReportFromRetentionReport(report(), { pgReadEnabled: false });

    expect(readiness.mode).toBe("pg_read_readiness");
    expect(readiness.overall_status).toBe("blocked");
    expect(readiness.summary).toMatchObject({ ready: 4, blocked: 2, pg_primary: 1 });
    expect(readiness.entities.find(entity => entity.entity === "documents")).toMatchObject({
      status: "ready",
      recommendation: "documents is eligible for an entity-scoped PG_READ rollout with normal latency monitoring.",
    });
    expect(readiness.entities.find(entity => entity.entity === "cases")).toMatchObject({
      status: "blocked",
      blockers: [
        { code: "ONLY_IN_REDIS", count: 1 },
        { code: "PG_ONLY_MANUAL_REVIEW", count: 2 },
      ],
      evidence: {
        only_in_redis_count: 1,
        only_in_pg_count: 2,
        manual_review_count: 2,
      },
    });
    expect(readiness.entities.find(entity => entity.entity === "work_items")).toMatchObject({
      status: "blocked",
      blockers: [{ code: "PG_ONLY_RETENTION_REQUIRED", count: 3 }],
      evidence: { safe_cleanup_candidate_count: 3 },
    });
    expect(readiness.entities.find(entity => entity.entity === "agents")).toMatchObject({
      status: "pg_primary",
      pg_read_path: "pg_primary",
    });
  });

  test("renders operator-readable blockers and recommendations", () => {
    const text = renderPgReadReadinessReportText(
      buildPgReadReadinessReportFromRetentionReport(report(), { pgReadEnabled: true }),
    );

    expect(text).toContain("=== Konoha PG_READ readiness report ===");
    expect(text).toContain("[BLOCKED] cases");
    expect(text).toContain("BLOCKER ONLY_IN_REDIS");
    expect(text).toContain("BLOCKER PG_ONLY_RETENTION_REQUIRED");
    expect(text).toContain("[PG_PRIMARY] agents");
  });
});
