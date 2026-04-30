import { describe, expect, test } from "bun:test";
import {
  ageBucket,
  buildCleanupPreviewFromRows,
  classifyRetentionCandidate,
  groupRetentionRows,
  idPrefix,
  processPrefix,
  retentionReportForAction,
  type PgOnlyRow,
} from "../src/retention/report";

const NOW = new Date("2026-04-30T12:00:00Z");

function row(partial: Partial<PgOnlyRow> & Pick<PgOnlyRow, "entity" | "id">): PgOnlyRow {
  return {
    status: null,
    process: null,
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
    ...partial,
  };
}

describe("PG-only retention report classification", () => {
  test("groups old completed generated cases as safe candidates", () => {
    const candidate = row({
      entity: "cases",
      id: "case-1",
      status: "done",
      process: "act-wf-1777520060601-direct",
      updated_at: "2026-04-10T00:00:00Z",
    });

    expect(classifyRetentionCandidate(candidate, NOW)).toBe("safe_candidate:old_completed_cases");
  });

  test("keeps recent generated cases in review", () => {
    const recent = row({
      entity: "cases",
      id: "case-2",
      status: "done",
      process: "act-wf-1777520060601-direct",
      updated_at: "2026-04-29T18:00:00Z",
    });

    expect(classifyRetentionCandidate(recent, NOW)).toBe("review");
  });

  test("classifies generated draft workflows and debug agents", () => {
    expect(classifyRetentionCandidate(row({
      entity: "workflows",
      id: "operator-eval-create-molde5ds",
      status: "draft",
    }), NOW)).toBe("safe_candidate:generated_draft_workflow");

    expect(classifyRetentionCandidate(row({
      entity: "agents",
      id: "debug-mcp-1777488527074",
      status: "offline",
    }), NOW)).toBe("safe_candidate:debug_agent");
  });

  test("builds deterministic grouping dimensions", () => {
    const groups = groupRetentionRows([
      row({ entity: "work_items", id: "wi-1", status: "done", process: "or-gw1777414694864", updated_at: "2026-04-01T00:00:00Z" }),
      row({ entity: "work_items", id: "wi-2", status: "done", process: "or-gw1777414694864", updated_at: "2026-04-01T00:00:00Z" }),
    ], NOW);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      entity: "work_items",
      candidate: "safe_candidate:old_completed_work_items",
      status: "done",
      process_prefix: "or-gw",
      id_prefix: "wi",
      age_bucket: "7-30d",
      would_delete_count: 2,
    });
    expect(groups[0].sample_ids).toEqual(["wi-1", "wi-2"]);
  });

  test("normalizes prefixes and age buckets", () => {
    expect(idPrefix("assistant-start-1777546667081")).toBe("assistant-start");
    expect(idPrefix("598fa5dd-9297-48c1-9c3b-c7bd864f7f2c")).toBe("uuid");
    expect(processPrefix("xor-gw1777399300852")).toBe("xor-gw");
    expect(ageBucket("2026-04-30T01:00:00Z", NOW)).toBe("<1d");
    expect(ageBucket("2026-04-20T00:00:00Z", NOW)).toBe("7-30d");
  });

  test("truncates action reports without changing source counts", () => {
    const groups = groupRetentionRows([
      row({ entity: "cases", id: "case-1", status: "done", process: "act-wf-1", updated_at: "2026-04-01T00:00:00Z" }),
      row({ entity: "work_items", id: "wi-1", status: "done", process: "or-gw1", updated_at: "2026-04-01T00:00:00Z" }),
    ], NOW);
    const report = retentionReportForAction({
      mode: "dry_run",
      generated_at: NOW.toISOString(),
      hard_fail: false,
      entityCounts: [],
      groups,
    }, 1);

    expect(report.groups).toHaveLength(1);
    expect(report.omitted_groups).toBe(1);
    expect(report.mode).toBe("dry_run");
  });

  test("cleanup preview returns exact safe candidate IDs without review rows", () => {
    const preview = buildCleanupPreviewFromRows([
      row({ entity: "cases", id: "case-safe", status: "done", process: "act-wf-1", updated_at: "2026-04-01T00:00:00Z" }),
      row({ entity: "cases", id: "case-business", status: "running", process: "sales-lead", updated_at: "2026-04-01T00:00:00Z" }),
      row({ entity: "reminders", id: "reminder-safe", status: "sent", updated_at: "2026-03-01T00:00:00Z" }),
    ], {
      generatedAt: NOW.toISOString(),
      hardFail: false,
      limit: 10,
      now: NOW,
    });

    expect(preview.mode).toBe("preview");
    expect(preview.total_candidates).toBe(2);
    expect(preview.omitted_candidates).toBe(0);
    expect(preview.candidates.map(candidate => candidate.id).sort()).toEqual(["case-safe", "reminder-safe"]);
    expect(preview.candidates.some(candidate => candidate.id === "case-business")).toBe(false);
  });

  test("cleanup preview is blocked when Redis-only mismatch exists", () => {
    const preview = buildCleanupPreviewFromRows([
      row({ entity: "cases", id: "case-safe", status: "done", process: "act-wf-1", updated_at: "2026-04-01T00:00:00Z" }),
    ], {
      generatedAt: NOW.toISOString(),
      hardFail: true,
      limit: 10,
      now: NOW,
    });

    expect(preview.hard_fail).toBe(true);
    expect(preview.blocked_reason).toContain("Redis-only rows");
    expect(preview.total_candidates).toBe(1);
    expect(preview.candidates).toEqual([]);
  });
});
