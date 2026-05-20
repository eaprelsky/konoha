import postgres from "postgres";
import { getDatabaseUrl } from "../src/storage/database-url";
import {
  DESTRUCTIVE_INTEGRATION_ENV,
  TEST_PG_SCHEMA_ENV,
  TEST_STORAGE_ENV,
  assertDestructiveIntegrationAudit,
  assertSafeTestPgSchema,
  destructiveIntegrationOverride,
  testPgSchema,
} from "../src/storage/test-isolation";

type TestPostgresOptions = NonNullable<Parameters<typeof postgres>[1]>;

export function getTestPgSchema(env: NodeJS.ProcessEnv = process.env): string {
  const schema = testPgSchema(env);
  if (destructiveIntegrationOverride(env)) {
    assertDestructiveIntegrationAudit(env);
    return schema;
  }

  if (env[TEST_STORAGE_ENV] !== "1") {
    throw new Error(
      `Unsafe test PostgreSQL client: ${TEST_STORAGE_ENV}=1 is required for Bun tests. ` +
      `Set ${DESTRUCTIVE_INTEGRATION_ENV}=1 only for a documented destructive integration run.`,
    );
  }

  assertSafeTestPgSchema(schema);
  return schema;
}

export function assertTestDatabaseUrl(databaseUrl: string, env: NodeJS.ProcessEnv = process.env): string {
  if (destructiveIntegrationOverride(env)) {
    assertDestructiveIntegrationAudit(env);
    return databaseUrl;
  }

  const schema = getTestPgSchema(env);
  const options = new URL(databaseUrl).searchParams.get("options") || "";
  if (!options.includes(`search_path=${schema},public`)) {
    throw new Error(
      `Unsafe test PostgreSQL client: database URL must include search_path=${schema},public ` +
      `when ${TEST_STORAGE_ENV}=1 and ${TEST_PG_SCHEMA_ENV}=${schema}.`,
    );
  }
  return databaseUrl;
}

export function getTestDatabaseUrl(): string {
  return assertTestDatabaseUrl(getDatabaseUrl());
}

export function createTestPostgres(options: TestPostgresOptions = {}) {
  return postgres(getTestDatabaseUrl(), options);
}
