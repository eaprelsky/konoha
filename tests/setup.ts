// Test environment setup — runs before all test files via bunfig.toml preload.
// Forces all Redis operations in tests to use DB 1, keeping production DB 0 clean.
process.env.REDIS_DB = "1";
// Disable PG reads in tests: all CRUD is validated through Redis (DB 1).
// pgUpsert* calls are fire-and-forget and may not settle before assertions.
process.env.PG_READ = "false";
