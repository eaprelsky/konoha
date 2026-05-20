import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { credentialConfig, getDatabaseUrl, hasDatabaseCredentials } from "../src/storage/database-url";

const REPO_ENV = "/home/ubuntu/konoha/.env";
const DEFAULT_TEST_STORAGE = process.env.KONOHA_TEST_STORAGE;
const DEFAULT_REDIS_DB = process.env.REDIS_DB;
const DEFAULT_TEST_PG_SCHEMA = process.env.KONOHA_TEST_PG_SCHEMA;
const DEFAULT_DESTRUCTIVE_OVERRIDE = process.env.KONOHA_ALLOW_DESTRUCTIVE_INTEGRATION_TESTS;

function cleanupFile(path: string) {
  try {
    rmSync(path, { force: true });
  } catch {}
}

// Restrict credential resolution to the repo .env only.
// System files (/opt/shared/.shared-credentials, /opt/konoha/.env.global)
// carry real DATABASE_URL values and would override test env vars.
credentialConfig.sources = [REPO_ENV];

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.PGHOST;
  delete process.env.PGPORT;
  delete process.env.PGDATABASE;
  delete process.env.PGUSER;
  delete process.env.PGPASSWORD;
  if (DEFAULT_TEST_STORAGE === undefined) delete process.env.KONOHA_TEST_STORAGE;
  else process.env.KONOHA_TEST_STORAGE = DEFAULT_TEST_STORAGE;
  if (DEFAULT_REDIS_DB === undefined) delete process.env.REDIS_DB;
  else process.env.REDIS_DB = DEFAULT_REDIS_DB;
  if (DEFAULT_TEST_PG_SCHEMA === undefined) delete process.env.KONOHA_TEST_PG_SCHEMA;
  else process.env.KONOHA_TEST_PG_SCHEMA = DEFAULT_TEST_PG_SCHEMA;
  if (DEFAULT_DESTRUCTIVE_OVERRIDE === undefined) delete process.env.KONOHA_ALLOW_DESTRUCTIVE_INTEGRATION_TESTS;
  else process.env.KONOHA_ALLOW_DESTRUCTIVE_INTEGRATION_TESTS = DEFAULT_DESTRUCTIVE_OVERRIDE;
  cleanupFile(REPO_ENV);
});

describe("database-url credential discovery", () => {
  test("prefers DATABASE_URL from process env", () => {
    delete process.env.KONOHA_TEST_STORAGE;
    process.env.DATABASE_URL = "postgres://env-user:env-pass@db.local:5432/app";
    expect(getDatabaseUrl()).toBe("postgres://env-user:env-pass@db.local:5432/app");
    expect(hasDatabaseCredentials()).toBe(true);
  });

  test("builds DATABASE_URL from PG* env parts", () => {
    delete process.env.KONOHA_TEST_STORAGE;
    process.env.PGHOST = "db.local";
    process.env.PGPORT = "5433";
    process.env.PGDATABASE = "app";
    process.env.PGUSER = "svc";
    process.env.PGPASSWORD = "secret";

    expect(getDatabaseUrl()).toBe("postgres://svc:secret@db.local:5433/app");
    expect(hasDatabaseCredentials()).toBe(true);
  });

  test("falls back to repo .env credential source", () => {
    delete process.env.KONOHA_TEST_STORAGE;
    mkdirSync("/home/ubuntu/konoha", { recursive: true });
    writeFileSync(REPO_ENV, "PGHOST=repo-db\nPGDATABASE=repo_app\nPGUSER=repo\nPGPASSWORD=repo-pass\n", "utf-8");

    expect(getDatabaseUrl()).toBe("postgres://repo:repo-pass@repo-db:5432/repo_app");
    expect(hasDatabaseCredentials()).toBe(true);
  });

  test("reports missing credentials when no safe source exists", () => {
    delete process.env.KONOHA_TEST_STORAGE;
    cleanupFile(REPO_ENV);
    if (existsSync("/opt/shared/.shared-credentials") || existsSync("/opt/konoha/.env.global")) {
      return;
    }
    expect(hasDatabaseCredentials()).toBe(false);
  });

  test("adds isolated test schema search_path when test storage is enabled", () => {
    process.env.KONOHA_TEST_STORAGE = "1";
    process.env.REDIS_DB = "2";
    process.env.KONOHA_TEST_PG_SCHEMA = "konoha_test_unit";
    process.env.DATABASE_URL = "postgres://env-user:env-pass@db.local:5432/app";

    const url = new URL(getDatabaseUrl());
    expect(url.protocol).toBe("postgres:");
    expect(url.username).toBe("env-user");
    expect(url.host).toBe("db.local:5432");
    expect(url.pathname).toBe("/app");
    expect(url.searchParams.get("options")).toContain("search_path=konoha_test_unit,public");
  });

  test("fails fast when test storage would use Redis DB 0", () => {
    process.env.KONOHA_TEST_STORAGE = "1";
    process.env.REDIS_DB = "0";
    process.env.KONOHA_TEST_PG_SCHEMA = "konoha_test_unit";
    process.env.DATABASE_URL = "postgres://env-user:env-pass@db.local:5432/app";

    expect(() => getDatabaseUrl()).toThrow("REDIS_DB must be a non-zero isolated DB");
  });

  test("fails fast when test storage schema is not test-scoped", () => {
    process.env.KONOHA_TEST_STORAGE = "1";
    process.env.REDIS_DB = "2";
    process.env.KONOHA_TEST_PG_SCHEMA = "public";
    process.env.DATABASE_URL = "postgres://env-user:env-pass@db.local:5432/app";

    expect(() => getDatabaseUrl()).toThrow("must start with konoha_test");
  });
});
