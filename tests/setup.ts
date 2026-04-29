// Test environment setup — runs before all test files via bunfig.toml preload.
// Forces all Redis operations in tests to use DB 1, keeping production DB 0 clean.
process.env.REDIS_DB = "1";
// Disable PG reads in tests: all CRUD is validated through Redis (DB 1).
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

import { rmSync } from "fs";
rmSync(process.env.KONOHA_DASHBOARD_AUTH_FILE, { force: true });
rmSync(process.env.KONOHA_SETUP_FILE, { force: true });

import Redis from "ioredis";

const flushRedis = new Redis({ db: 1, lazyConnect: true });

// Flush Redis DB 1 before each test run to ensure clean slate.
// Per-file isolation is the responsibility of each test file's afterAll hook.
await flushRedis.connect();
await flushRedis.flushdb();
await flushRedis.quit();
