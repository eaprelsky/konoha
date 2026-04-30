import { describe, expect, test } from "bun:test";
import {
  ageBucket,
  classifyRetentionCandidate,
  groupRetentionRows,
  idPrefix,
  processPrefix,
  type PgOnlyRow,
} from "../scripts/pg-only-retention-report";

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
});
