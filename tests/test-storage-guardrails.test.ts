import { describe, expect, test } from "bun:test";
import {
  DESTRUCTIVE_INTEGRATION_ENV,
  DESTRUCTIVE_INTEGRATION_REASON_ENV,
  DESTRUCTIVE_INTEGRATION_TARGET_ENV,
  TEST_PG_SCHEMA_ENV,
  TEST_STORAGE_ENV,
  applyBunTestStorageDefaults,
  assertSafeBunTestStorageEnv,
} from "../src/storage/test-isolation";

describe("Bun test storage fail-fast guardrails", () => {
  test("safe defaults isolate Redis and PostgreSQL before clients are constructed", () => {
    const env: NodeJS.ProcessEnv = {};
    applyBunTestStorageDefaults(env, 12345);

    expect(env[TEST_STORAGE_ENV]).toBe("1");
    expect(env.REDIS_DB).toBe("1");
    expect(env[TEST_PG_SCHEMA_ENV]).toBe("konoha_test_12345");
  });

  test("missing preload contract fails before touching storage", () => {
    expect(() => assertSafeBunTestStorageEnv({ REDIS_DB: "1", [TEST_PG_SCHEMA_ENV]: "konoha_test_unit" })).toThrow(
      "KONOHA_TEST_STORAGE=1 is required",
    );
  });

  test("Redis DB 0 is rejected without destructive audit metadata", () => {
    expect(() =>
      assertSafeBunTestStorageEnv({
        [TEST_STORAGE_ENV]: "1",
        REDIS_DB: "0",
        [TEST_PG_SCHEMA_ENV]: "konoha_test_unit",
      }),
    ).toThrow("REDIS_DB must be a non-zero isolated DB");
  });

  test("PostgreSQL public schema is rejected without destructive audit metadata", () => {
    expect(() =>
      assertSafeBunTestStorageEnv({
        [TEST_STORAGE_ENV]: "1",
        REDIS_DB: "1",
        [TEST_PG_SCHEMA_ENV]: "public",
      }),
    ).toThrow("must start with konoha_test");
  });

  test("destructive override requires target and reason before it can bypass safe defaults", () => {
    expect(() => assertSafeBunTestStorageEnv({ [DESTRUCTIVE_INTEGRATION_ENV]: "1", REDIS_DB: "0" })).toThrow(
      "requires KONOHA_DESTRUCTIVE_INTEGRATION_TARGET",
    );

    expect(() =>
      assertSafeBunTestStorageEnv({
        [DESTRUCTIVE_INTEGRATION_ENV]: "1",
        [DESTRUCTIVE_INTEGRATION_TARGET_ENV]: "local-dev-storage",
        [DESTRUCTIVE_INTEGRATION_REASON_ENV]: "manual destructive integration smoke",
        REDIS_DB: "0",
        [TEST_PG_SCHEMA_ENV]: "public",
      }),
    ).not.toThrow();
  });
});
