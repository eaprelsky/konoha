export const TEST_STORAGE_ENV = "KONOHA_TEST_STORAGE";
export const DESTRUCTIVE_INTEGRATION_ENV = "KONOHA_ALLOW_DESTRUCTIVE_INTEGRATION_TESTS";
export const TEST_PG_SCHEMA_ENV = "KONOHA_TEST_PG_SCHEMA";
export const DEFAULT_TEST_PG_SCHEMA = "konoha_test";

export function destructiveIntegrationOverride(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[DESTRUCTIVE_INTEGRATION_ENV] === "1";
}

export function testStorageEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[TEST_STORAGE_ENV] === "1" && !destructiveIntegrationOverride(env);
}

export function testPgSchema(env: NodeJS.ProcessEnv = process.env): string {
  return env[TEST_PG_SCHEMA_ENV] || DEFAULT_TEST_PG_SCHEMA;
}

export function assertSafeTestRedis(env: NodeJS.ProcessEnv = process.env): void {
  if (!testStorageEnabled(env)) return;
  const redisDb = Number(env.REDIS_DB ?? "0");
  if (!Number.isInteger(redisDb) || redisDb <= 0) {
    throw new Error(
      `Unsafe test storage: REDIS_DB must be a non-zero isolated DB when ${TEST_STORAGE_ENV}=1. ` +
      `Set REDIS_DB=1 or ${DESTRUCTIVE_INTEGRATION_ENV}=1 for an explicit destructive integration run.`,
    );
  }
}

export function assertSafeTestPgSchema(schema: string): void {
  if (!/^konoha_test(?:_[A-Za-z0-9]+)*$/.test(schema)) {
    throw new Error(
      `Unsafe test storage: ${TEST_PG_SCHEMA_ENV} must start with konoha_test; got ${schema}. ` +
      `Set ${DESTRUCTIVE_INTEGRATION_ENV}=1 for an explicit destructive integration run.`,
    );
  }
}

export function withPgSearchPath(databaseUrl: string, schema: string): string {
  assertSafeTestPgSchema(schema);
  const url = new URL(databaseUrl);
  const existingOptions = url.searchParams.get("options")?.trim();
  const searchPathOption = `-c search_path=${schema},public`;
  url.searchParams.set("options", existingOptions ? `${existingOptions} ${searchPathOption}` : searchPathOption);
  return url.toString();
}

export function resolveTestDatabaseUrl(databaseUrl: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!testStorageEnabled(env)) return databaseUrl;
  assertSafeTestRedis(env);
  return withPgSearchPath(databaseUrl, testPgSchema(env));
}
