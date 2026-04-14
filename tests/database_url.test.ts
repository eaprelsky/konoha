import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { getDatabaseUrl, hasDatabaseCredentials } from "../src/storage/database-url";

const REPO_ENV = "/home/ubuntu/konoha/.env";

function cleanupFile(path: string) {
  try {
    rmSync(path, { force: true });
  } catch {}
}

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.PGHOST;
  delete process.env.PGPORT;
  delete process.env.PGDATABASE;
  delete process.env.PGUSER;
  delete process.env.PGPASSWORD;
  cleanupFile(REPO_ENV);
});

describe("database-url credential discovery", () => {
  test("prefers DATABASE_URL from process env", () => {
    process.env.DATABASE_URL = "postgres://env-user:env-pass@db.local:5432/app";
    expect(getDatabaseUrl()).toBe("postgres://env-user:env-pass@db.local:5432/app");
    expect(hasDatabaseCredentials()).toBe(true);
  });

  test("builds DATABASE_URL from PG* env parts", () => {
    process.env.PGHOST = "db.local";
    process.env.PGPORT = "5433";
    process.env.PGDATABASE = "app";
    process.env.PGUSER = "svc";
    process.env.PGPASSWORD = "secret";

    expect(getDatabaseUrl()).toBe("postgres://svc:secret@db.local:5433/app");
    expect(hasDatabaseCredentials()).toBe(true);
  });

  test("falls back to repo .env credential source", () => {
    mkdirSync("/home/ubuntu/konoha", { recursive: true });
    writeFileSync(REPO_ENV, "PGHOST=repo-db\nPGDATABASE=repo_app\nPGUSER=repo\nPGPASSWORD=repo-pass\n", "utf-8");

    expect(getDatabaseUrl()).toBe("postgres://repo:repo-pass@repo-db:5432/repo_app");
    expect(hasDatabaseCredentials()).toBe(true);
  });

  test("reports missing credentials when no safe source exists", () => {
    cleanupFile(REPO_ENV);
    if (existsSync("/opt/shared/.shared-credentials") || existsSync("/opt/konoha/.env.global")) {
      return;
    }
    expect(hasDatabaseCredentials()).toBe(false);
  });
});
