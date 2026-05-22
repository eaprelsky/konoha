import { describe, expect, test } from "bun:test";
import {
  evaluateRuntimeArtifactRetention,
  loadRuntimeRetentionPolicy,
  REQUIRED_RUNTIME_RETENTION_ENTITIES,
  validateRuntimeRetentionPolicyContract,
  type RuntimeRetentionEntity,
} from "../src/retention/runtime-policy";

describe("high-volume runtime retention policy", () => {
  test("is a valid machine-readable contract for all runtime artifact classes", () => {
    const policy = loadRuntimeRetentionPolicy();
    expect(validateRuntimeRetentionPolicyContract(policy)).toEqual([]);

    const covered = new Set(policy.retention_classes.map(item => item.entity));
    expect([...covered].sort()).toEqual([...REQUIRED_RUNTIME_RETENTION_ENTITIES].sort());

    for (const entity of REQUIRED_RUNTIME_RETENTION_ENTITIES) {
      const classes = policy.retention_classes.filter(item => item.entity === entity);
      expect(classes.length).toBeGreaterThan(0);
      expect(classes.every(item => item.redis_primary && item.postgres_shadow)).toBe(true);
    }
  });

  test("archives and compacts only terminal high-volume cases after safety gates pass", () => {
    const policy = loadRuntimeRetentionPolicy();

    expect(evaluateRuntimeArtifactRetention(policy, {
      entity: "case",
      state: "active",
      age_hours: 720,
      volume: "high",
      pg_shadow_consistent: true,
    })).toMatchObject({
      retention_class: "runtime.case.active",
      archive_eligible: false,
      compact_eligible: false,
      visible_by_default: true,
    });

    expect(evaluateRuntimeArtifactRetention(policy, {
      entity: "case",
      state: "completed",
      age_hours: 200,
      volume: "high",
      active_work_items: 0,
      active_waits: 0,
      pending_effects: 0,
      pg_shadow_consistent: true,
      redis_only_rows: 0,
    })).toMatchObject({
      retention_class: "runtime.case.completed.high_volume",
      archive_eligible: true,
      compact_eligible: true,
      visible_by_default: true,
      blocked: false,
    });
  });

  test("selects active case retention class before high-volume completed policy", () => {
    const policy = loadRuntimeRetentionPolicy();

    expect(evaluateRuntimeArtifactRetention(policy, {
      entity: "case",
      state: "active",
      age_hours: 1000,
      volume: "high",
      active_work_items: 1,
      pg_shadow_consistent: true,
      redis_only_rows: 0,
    })).toMatchObject({
      retention_class: "runtime.case.active",
      archive_eligible: false,
      compact_eligible: false,
      visible_by_default: true,
    });
  });

  test("blocks archive and compaction while active waits or effects can still fire", () => {
    const policy = loadRuntimeRetentionPolicy();
    const decision = evaluateRuntimeArtifactRetention(policy, {
      entity: "case",
      state: "completed",
      age_hours: 200,
      volume: "high",
      active_waits: 1,
      pending_effects: 1,
      pg_shadow_consistent: true,
      redis_only_rows: 0,
    });

    expect(decision.archive_eligible).toBe(false);
    expect(decision.compact_eligible).toBe(false);
    expect(decision.blocked).toBe(true);
    expect(decision.reasons).toContain("active waits block archive/compaction");
    expect(decision.reasons).toContain("pending or retry runtime effects block archive/compaction");
  });

  test("keeps archived and compacted artifacts hidden by default but audit-expandable", () => {
    const policy = loadRuntimeRetentionPolicy();
    for (const state of ["archived", "compacted"] as const) {
      expect(policy.defaults.ui_default_filter.hide_states).toContain(state);
      expect(policy.defaults.ui_default_filter.audit_query_can_include_states).toContain(state);
      expect(evaluateRuntimeArtifactRetention(policy, {
        entity: "timeline_event",
        state,
        age_hours: 500,
        volume: "high",
        pg_shadow_consistent: true,
      }).visible_by_default).toBe(false);
    }
  });

  test("ties PG_READ and cleanup safety to Redis-primary consistency", () => {
    const policy = loadRuntimeRetentionPolicy();
    expect(policy.safety_gates.redis_primary_until_pg_read_entity_safe).toBe(true);
    expect(policy.safety_gates.block_when_redis_only_rows).toBe(true);
    expect(policy.pg_read_and_retention_tooling.cutover_guard).toContain("no Redis-only rows");

    const decision = evaluateRuntimeArtifactRetention(policy, {
      entity: "runtime_effect",
      state: "completed",
      age_hours: 200,
      volume: "high",
      pg_shadow_consistent: false,
      redis_only_rows: 2,
    });

    expect(decision.archive_eligible).toBe(false);
    expect(decision.compact_eligible).toBe(false);
    expect(decision.reasons).toContain("PostgreSQL shadow consistency is required");
    expect(decision.reasons).toContain("Redis-only rows block cleanup and archival decisions");
  });

  test("defines explicit high-volume messenger activation and cost budgets", () => {
    const policy = loadRuntimeRetentionPolicy();
    const messenger = policy.workflow_activation_policies.find(item => item.profile === "high_volume_messenger");
    expect(messenger).toBeDefined();
    expect(messenger?.requires_explicit_activation).toBe(true);
    expect(messenger?.dedupe_key).toEqual(["connector", "chat_id", "message_id"]);
    expect(messenger?.budgets.max_cases_per_hour).toBeGreaterThan(0);
    expect(messenger?.budgets.max_timeline_events_visible_by_default).toBeLessThanOrEqual(50);
    expect(messenger?.backpressure.monitor_signal).toBe("runtime_retention.high_volume_budget_pressure");
  });

  test("retention classes stay bound to known entity vocabulary", () => {
    const policy = loadRuntimeRetentionPolicy();
    const known = new Set<RuntimeRetentionEntity>(REQUIRED_RUNTIME_RETENTION_ENTITIES);
    for (const item of policy.retention_classes) {
      expect(known.has(item.entity)).toBe(true);
    }
  });
});
