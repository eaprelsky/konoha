import Redis, { type RedisOptions } from "ioredis";
import {
  DESTRUCTIVE_INTEGRATION_ENV,
  TEST_STORAGE_ENV,
  assertSafeTestRedis,
  destructiveIntegrationOverride,
} from "../src/storage/test-isolation";

type TestRedisOptions = Omit<RedisOptions, "host" | "port" | "db">;

export function getTestRedisDb(env: NodeJS.ProcessEnv = process.env): number {
  const redisDb = Number(env.REDIS_DB ?? "0");
  if (!Number.isInteger(redisDb) || redisDb < 0) {
    throw new Error(`Invalid test Redis DB: REDIS_DB must be a non-negative integer; got ${env.REDIS_DB}`);
  }

  if (destructiveIntegrationOverride(env)) return redisDb;

  if (env[TEST_STORAGE_ENV] !== "1") {
    throw new Error(
      `Unsafe test Redis client: ${TEST_STORAGE_ENV}=1 is required for Bun tests. ` +
      `Set ${DESTRUCTIVE_INTEGRATION_ENV}=1 only for a documented destructive integration run.`,
    );
  }

  assertSafeTestRedis(env);
  return redisDb;
}

export function createTestRedis(options: TestRedisOptions = {}): Redis {
  return new Redis({ host: "127.0.0.1", port: 6379, ...options, db: getTestRedisDb() });
}
