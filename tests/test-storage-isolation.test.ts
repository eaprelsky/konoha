import { describe, expect, test } from "bun:test";
import { getDatabaseUrl } from "../src/storage/database-url";

describe("default test storage isolation", () => {
  test("bun test preload enables isolated Redis and PostgreSQL targets", () => {
    expect(process.env.KONOHA_TEST_STORAGE).toBe("1");
    expect(Number(process.env.REDIS_DB)).toBeGreaterThan(0);
    expect(process.env.KONOHA_TEST_PG_SCHEMA).toMatch(/^konoha_test/);

    const url = new URL(getDatabaseUrl());
    expect(url.searchParams.get("options")).toContain(`search_path=${process.env.KONOHA_TEST_PG_SCHEMA},public`);
  });
});
