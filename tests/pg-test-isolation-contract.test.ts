import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join, relative } from "path";
import {
  DESTRUCTIVE_INTEGRATION_ENV,
  DESTRUCTIVE_INTEGRATION_REASON_ENV,
  DESTRUCTIVE_INTEGRATION_TARGET_ENV,
  TEST_PG_SCHEMA_ENV,
  TEST_STORAGE_ENV,
  withPgSearchPath,
} from "../src/storage/test-isolation";
import { assertTestDatabaseUrl, getTestPgSchema } from "./pg-test-utils";

const TESTS_DIR = new URL(".", import.meta.url).pathname;
const PG_HELPER = "pg-test-utils.ts";

function listTypeScriptFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(fullPath);
    if (!entry.isFile() || !entry.name.endsWith(".ts")) return [];
    return [fullPath];
  });
}

describe("Bun PostgreSQL test isolation contract", () => {
  test("all test PostgreSQL clients go through the audited helper", () => {
    const offenders = listTypeScriptFiles(TESTS_DIR)
      .filter((file) => relative(TESTS_DIR, file) !== PG_HELPER)
      .flatMap((file) => {
        const source = readFileSync(file, "utf-8");
        const problems = [];
        if (/from\s+["']postgres["']/.test(source)) problems.push("imports postgres directly");
        if (/import\s*\(\s*["']postgres["']\s*\)/.test(source)) problems.push("dynamically imports postgres directly");
        if (/\bpostgres\s*\(/.test(source)) problems.push("constructs PostgreSQL client directly");
        return problems.map((problem) => `${relative(TESTS_DIR, file)}: ${problem}`);
      });

    expect(offenders).toEqual([]);
  });

  test("test PostgreSQL schema defaults reject production public schema", () => {
    expect(() => getTestPgSchema({ [TEST_STORAGE_ENV]: "1", [TEST_PG_SCHEMA_ENV]: "public" })).toThrow(
      "must start with konoha_test",
    );
  });

  test("test database URL must include disposable schema search_path", () => {
    expect(() =>
      assertTestDatabaseUrl("postgres://test:test@127.0.0.1:5432/konoha", {
        [TEST_STORAGE_ENV]: "1",
        [TEST_PG_SCHEMA_ENV]: "konoha_test_contract",
      }),
    ).toThrow("must include search_path=konoha_test_contract,public");
  });

  test("test database URL accepts matching disposable schema search_path", () => {
    const env = { [TEST_STORAGE_ENV]: "1", [TEST_PG_SCHEMA_ENV]: "konoha_test_contract" };
    const url = withPgSearchPath("postgres://test:test@127.0.0.1:5432/konoha", "konoha_test_contract");
    expect(assertTestDatabaseUrl(url, env)).toBe(url);
  });

  test("destructive integration override is explicit and auditable", () => {
    expect(() => getTestPgSchema({ [DESTRUCTIVE_INTEGRATION_ENV]: "1", [TEST_PG_SCHEMA_ENV]: "public" })).toThrow(
      "requires KONOHA_DESTRUCTIVE_INTEGRATION_TARGET",
    );
    const env = {
      [DESTRUCTIVE_INTEGRATION_ENV]: "1",
      [DESTRUCTIVE_INTEGRATION_TARGET_ENV]: "local-public-schema",
      [DESTRUCTIVE_INTEGRATION_REASON_ENV]: "manual rollback rehearsal",
      [TEST_PG_SCHEMA_ENV]: "public",
    };
    expect(getTestPgSchema(env)).toBe("public");
    expect(assertTestDatabaseUrl("postgres://test:test@127.0.0.1:5432/konoha", env)).toBe(
      "postgres://test:test@127.0.0.1:5432/konoha",
    );
  });
});
