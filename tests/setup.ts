// Test environment setup — runs before all test files via bunfig.toml preload.
// Forces all Redis operations in tests to use DB 1, keeping production DB 0 clean.
process.env.REDIS_DB = "1";
// Disable PG reads in tests: all CRUD is validated through Redis (DB 1).
// pgUpsert* calls are fire-and-forget and may not settle before assertions.
process.env.PG_READ = "false";

import Redis from "ioredis";

const flushRedis = new Redis({ db: 1, lazyConnect: true });

// Flush Redis DB 1 before each test run to ensure clean slate.
// Per-file isolation is the responsibility of each test file's afterAll hook.
await flushRedis.connect();
await flushRedis.flushdb();
await flushRedis.quit();
