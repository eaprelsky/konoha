// Test environment setup — runs before all test files via bunfig.toml preload.
// Forces all Redis operations in tests to use DB 1, keeping production DB 0 clean.
process.env.REDIS_DB = "1";
