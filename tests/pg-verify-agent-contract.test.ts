import { describe, expect, test } from "bun:test";
import {
  compareAgentPresence,
  compareManagedAgentDefinitionStores,
} from "../src/pg-verify-agents";

describe("pg-verify agent source-of-truth contract", () => {
  test("treats PostgreSQL agent presence as canonical instead of managed definition drift", () => {
    const result = compareAgentPresence(
      ["kakashi", "legacy-only"],
      ["external-operator", "kakashi", "naruto"],
    );

    expect(result).toMatchObject({
      entity: "agent_presence",
      ok: true,
      redisLabel: "Redis legacy registry",
      pgLabel: "PG presence",
      onlyInRedis: ["legacy-only"],
      onlyInPg: ["external-operator", "naruto"],
      onlyInPgDisposition: "canonical, OK",
      onlyInRedisIsWarning: true,
      ignoreOnlyInPgBloat: true,
      strictOnlyInPgIsError: false,
    });
  });

  test("validates managed AgentDef projection completeness without requiring bus presence", () => {
    const result = compareManagedAgentDefinitionStores({
      legacyIds: ["legacy-missing-projections", "naruto"],
      templateIds: ["naruto", "split-only"],
      runtimeConfigIds: ["naruto", "runtime-only", "split-only"],
    });

    expect(result.entity).toBe("managed_agent_definitions");
    expect(result.ok).toBe(false);
    expect(result.onlyInRedis).toEqual([
      "legacy-missing-projections:missing_template+runtime_config",
      "runtime-only:missing_template",
    ]);
    expect(result.onlyInPg).toEqual([]);
  });

  test("allows split-only managed definitions when template and runtime config both exist", () => {
    const result = compareManagedAgentDefinitionStores({
      legacyIds: ["naruto"],
      templateIds: ["naruto", "split-only"],
      runtimeConfigIds: ["naruto", "split-only"],
    });

    expect(result.ok).toBe(true);
    expect(result.redisCount).toBe(2);
    expect(result.pgCount).toBe(2);
    expect(result.onlyInRedis).toEqual([]);
  });
});
