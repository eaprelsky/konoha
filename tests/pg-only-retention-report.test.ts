import { describe, expect, test } from "bun:test";
import {
  ageBucket,
  buildCleanupApplyPlanFromRows,
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

  test("cleanup preview supports explicit null limit for full operator review", () => {
    const preview = buildCleanupPreviewFromRows([
      row({ entity: "cases", id: "case-1", status: "done", process: "act-wf-1", updated_at: "2026-04-01T00:00:00Z" }),
      row({ entity: "cases", id: "case-2", status: "done", process: "act-wf-2", updated_at: "2026-04-01T00:00:00Z" }),
    ], {
      generatedAt: NOW.toISOString(),
      hardFail: false,
      limit: null,
      now: NOW,
    });

    expect(preview.total_candidates).toBe(2);
    expect(preview.omitted_candidates).toBe(0);
    expect(preview.candidates.map(candidate => candidate.id)).toEqual(["case-1", "case-2"]);
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

  test("cleanup apply plan approves only exact current safe candidates", () => {
    const plan = buildCleanupApplyPlanFromRows([
      row({ entity: "cases", id: "case-safe", status: "done", process: "act-wf-1", updated_at: "2026-04-01T00:00:00Z" }),
    ], [
      { entity: "cases", id: "case-safe", candidate: "safe_candidate:old_completed_cases" },
    ], {
      generatedAt: NOW.toISOString(),
      hardFail: false,
      confirmed: true,
      now: NOW,
    });

    expect(plan.blocked_reason).toBeUndefined();
    expect(plan.approved_count).toBe(1);
    expect(plan.deleted_count).toBe(0);
    expect(plan.deleted.map(candidate => candidate.id)).toEqual(["case-safe"]);
  });

  test("cleanup apply plan is all-or-nothing for invalid or stale candidates", () => {
    const plan = buildCleanupApplyPlanFromRows([
      row({ entity: "cases", id: "case-safe", status: "done", process: "act-wf-1", updated_at: "2026-04-01T00:00:00Z" }),
      row({ entity: "cases", id: "case-business", status: "running", process: "sales-lead", updated_at: "2026-04-01T00:00:00Z" }),
    ], [
      { entity: "cases", id: "case-safe", candidate: "safe_candidate:old_completed_cases" },
      { entity: "cases", id: "case-business", candidate: "safe_candidate:old_completed_cases" },
    ], {
      generatedAt: NOW.toISOString(),
      hardFail: false,
      confirmed: true,
      now: NOW,
    });

    expect(plan.applied).toBe(false);
    expect(plan.blocked_reason).toContain("all-or-nothing");
    expect(plan.approved_count).toBe(0);
    expect(plan.deleted).toEqual([]);
    expect(plan.rejected).toEqual([
      {
        entity: "cases",
        id: "case-business",
        candidate: "safe_candidate:old_completed_cases",
        reason: "not present in current safe PG-only candidate set",
      },
    ]);
  });

  test("cleanup apply plan requires explicit confirmation and bounded batches", () => {
    const unconfirmed = buildCleanupApplyPlanFromRows([], [], {
      generatedAt: NOW.toISOString(),
      hardFail: false,
      confirmed: false,
      now: NOW,
    });
    expect(unconfirmed.blocked_reason).toContain("confirm=true");

    const oversized = buildCleanupApplyPlanFromRows([], [
      { entity: "cases", id: "case-1", candidate: "safe_candidate:old_completed_cases" },
      { entity: "cases", id: "case-2", candidate: "safe_candidate:old_completed_cases" },
    ], {
      generatedAt: NOW.toISOString(),
      hardFail: false,
      confirmed: true,
      maxBatchSize: 1,
      now: NOW,
    });
    expect(oversized.blocked_reason).toContain("all-or-nothing");
    expect(oversized.rejected.some(item => item.reason.includes("exceeds max 1"))).toBe(true);
  });
});
