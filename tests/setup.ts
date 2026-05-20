// Test environment setup — runs before all test files via bunfig.toml preload.
// Default tests must not touch production Redis DB 0 or the production PG schema.
const destructiveIntegration = process.env.KONOHA_ALLOW_DESTRUCTIVE_INTEGRATION_TESTS === "1";
if (!destructiveIntegration) {
  process.env.KONOHA_TEST_STORAGE = "1";
  process.env.REDIS_DB = process.env.KONOHA_TEST_REDIS_DB || "1";
  process.env.KONOHA_TEST_PG_SCHEMA = process.env.KONOHA_TEST_PG_SCHEMA || `konoha_test_${process.pid}`;
}
// Disable PG reads in tests: all CRUD is validated through isolated Redis.
// pgUpsert* calls are fire-and-forget and may not settle before assertions.
process.env.PG_READ = "false";
// Use a stable test admin token. Server.test.ts restores it in afterAll if it
// mutates it, but the preload must set it first so all files see the same token.
process.env.KONOHA_TOKEN = "test-admin-token-preload";
process.env.KONOHA_DASHBOARD_USER = "test-admin";
process.env.KONOHA_DASHBOARD_PASSWORD = "test-dashboard-password";
process.env.KONOHA_DASHBOARD_HOSTS = "dashboard.test";
process.env.KONOHA_DASHBOARD_AUTH_FILE = "/tmp/konoha-dashboard-auth-test.json";
process.env.KONOHA_SETUP_FILE = "/tmp/konoha-setup-test.json";

import { readFileSync, rmSync } from "fs";
rmSync(process.env.KONOHA_DASHBOARD_AUTH_FILE, { force: true });
rmSync(process.env.KONOHA_SETUP_FILE, { force: true });

import { createTestRedis } from "./redis-test-utils";
import postgres from "postgres";

const flushRedis = createTestRedis({ lazyConnect: true });

// Flush the isolated Redis DB before each test run to ensure clean slate.
// Per-file isolation is the responsibility of each test file's afterAll hook.
await flushRedis.connect();
await flushRedis.flushdb();
await flushRedis.quit();

if (!destructiveIntegration) {
  const { getDatabaseUrl } = await import("../src/storage/database-url");
  const { testPgSchema } = await import("../src/storage/test-isolation");
  const schema = testPgSchema();
  const sql = postgres(getDatabaseUrl(), {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 5,
    onnotice: () => {},
  });
  try {
    await sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`;
    await sql`CREATE SCHEMA ${sql(schema)}`;
    await sql`SET search_path TO ${sql(schema)}, public`;
    const schemaSql = readFileSync(new URL("../src/storage/schema.sql", import.meta.url), "utf-8")
      .replace(/^CREATE EXTENSION IF NOT EXISTS "uuid-ossp";\s*$/m, "");
    await sql.unsafe(schemaSql);
  } finally {
    await sql.end();
  }
}
