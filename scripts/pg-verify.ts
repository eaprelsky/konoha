#!/usr/bin/env bun
/**
 * pg-verify.ts — сравнение данных Redis vs PostgreSQL
 *
 * Запуск:
 *   cd /home/ubuntu/konoha && bun run scripts/pg-verify.ts
 *
 * Выводит:
 *   - количество записей в Redis и PG по каждой сущности
 *   - расхождения по конкретным ID
 *   - итоговый статус: OK / MISMATCH
 */

import Redis from "ioredis";
import postgres from "postgres";
import { getDatabaseUrl } from "../src/storage/database-url";

const DATABASE_URL = getDatabaseUrl();

const redis = new Redis({ host: "127.0.0.1", port: 6379, db: 0, lazyConnect: false });
const sql = postgres(DATABASE_URL, { max: 3, idle_timeout: 10, connect_timeout: 5, onnotice: () => {} });

interface CheckResult {
  entity: string;
  redisCount: number;
  pgCount: number;
  onlyInRedis: string[];
  onlyInPg: string[];
  ok: boolean;
}

async function scanKeys(match: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";

  do {
    const [nextCursor, batch] = await redis.scan(cursor, "MATCH", match, "COUNT", 100);
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== "0");

  return keys.sort();
}

async function scanStreamKeys(match: string): Promise<string[]> {
  const keys = await scanKeys(match);
  const streamKeys: string[] = [];

  for (const key of keys) {
    if ((await redis.type(key)) === "stream") {
      streamKeys.push(key);
    }
  }

  return streamKeys;
}

async function checkCases(): Promise<CheckResult> {
  const redisIds = await redis.zrange("konoha:cases:all", 0, -1);
  const pgRows = await sql<{ case_id: string }[]>`SELECT case_id FROM cases`;
  const pgIds = pgRows.map(r => r.case_id);

  const redisSet = new Set(redisIds);
  const pgSet = new Set(pgIds);

  return {
    entity: "cases",
    redisCount: redisIds.length,
    pgCount: pgIds.length,
    onlyInRedis: redisIds.filter(id => !pgSet.has(id)),
    onlyInPg:    pgIds.filter(id => !redisSet.has(id)),
    // Migration check: every Redis record must exist in PG (no data loss).
    // Extra records in PG (archived/historical data no longer in Redis) are acceptable.
    ok: redisIds.every(id => pgSet.has(id)),
  };
}

async function checkWorkItems(): Promise<CheckResult> {
  const redisIds = await redis.zrange("konoha:workitems:all", 0, -1);
  const pgRows = await sql<{ id: string }[]>`SELECT id FROM work_items`;
  const pgIds = pgRows.map(r => r.id);

  const redisSet = new Set(redisIds);
  const pgSet = new Set(pgIds);

  return {
    entity: "work_items",
    redisCount: redisIds.length,
    pgCount: pgIds.length,
    onlyInRedis: redisIds.filter(id => !pgSet.has(id)),
    onlyInPg:    pgIds.filter(id => !redisSet.has(id)),
    // Migration check: every Redis record must exist in PG (no data loss).
    // Extra records in PG (archived/historical data no longer in Redis) are acceptable.
    ok: redisIds.every(id => pgSet.has(id)),
  };
}

async function checkWorkflows(): Promise<CheckResult> {
  const redisIds = await redis.smembers("konoha:workflow:index");
  const pgRows = await sql<{ id: string }[]>`SELECT id FROM workflows`;
  const pgIds = pgRows.map(r => r.id);

  const redisSet = new Set(redisIds);
  const pgSet = new Set(pgIds);

  return {
    entity: "workflows",
    redisCount: redisIds.length,
    pgCount: pgIds.length,
    onlyInRedis: redisIds.filter(id => !pgSet.has(id)),
    onlyInPg:    pgIds.filter(id => !redisSet.has(id)),
    // Migration check: every Redis record must exist in PG (no data loss).
    // Extra records in PG (archived/historical data no longer in Redis) are acceptable.
    ok: redisIds.every(id => pgSet.has(id)),
  };
}

async function checkRoles(): Promise<CheckResult> {
  const redisIds = await redis.zrange("konoha:roles:all", 0, -1);
  const pgRows = await sql<{ id: string }[]>`SELECT id FROM roles`;
  const pgIds = pgRows.map(r => r.id);

  const redisSet = new Set(redisIds);
  const pgSet = new Set(pgIds);

  return {
    entity: "roles",
    redisCount: redisIds.length,
    pgCount: pgIds.length,
    onlyInRedis: redisIds.filter(id => !pgSet.has(id)),
    onlyInPg:    pgIds.filter(id => !redisSet.has(id)),
    // Migration check: every Redis record must exist in PG (no data loss).
    // Extra records in PG (archived/historical data no longer in Redis) are acceptable.
    ok: redisIds.every(id => pgSet.has(id)),
  };
}

async function checkDocs(): Promise<CheckResult> {
  const redisIds = await redis.zrange("konoha:docs:all", 0, -1);
  const pgRows = await sql<{ id: string }[]>`SELECT id FROM documents`;
  const pgIds = pgRows.map(r => r.id);

  const redisSet = new Set(redisIds);
  const pgSet = new Set(pgIds);

  return {
    entity: "documents",
    redisCount: redisIds.length,
    pgCount: pgIds.length,
    onlyInRedis: redisIds.filter(id => !pgSet.has(id)),
    onlyInPg:    pgIds.filter(id => !redisSet.has(id)),
    // Migration check: every Redis record must exist in PG (no data loss).
    // Extra records in PG (archived/historical data no longer in Redis) are acceptable.
    ok: redisIds.every(id => pgSet.has(id)),
  };
}

async function checkReminders(): Promise<CheckResult> {
  const redisIds = await redis.zrange("konoha:reminders:all", 0, -1);
  const pgRows = await sql<{ id: string }[]>`SELECT id FROM reminders`;
  const pgIds = pgRows.map(r => r.id);

  const redisSet = new Set(redisIds);
  const pgSet = new Set(pgIds);

  return {
    entity: "reminders",
    redisCount: redisIds.length,
    pgCount: pgIds.length,
    onlyInRedis: redisIds.filter(id => !pgSet.has(id)),
    onlyInPg:    pgIds.filter(id => !redisSet.has(id)),
    // Migration check: every Redis record must exist in PG (no data loss).
    // Extra records in PG (archived/historical data no longer in Redis) are acceptable.
    ok: redisIds.every(id => pgSet.has(id)),
  };
}

async function checkAgents(): Promise<CheckResult> {
  const redisIds = await redis.hkeys("konoha:registry");
  const pgRows = await sql<{ id: string }[]>`SELECT id FROM konoha_agents`;
  const pgIds = pgRows.map(r => r.id);

  const redisSet = new Set(redisIds);
  const pgSet = new Set(pgIds);

  return {
    entity: "agents",
    redisCount: redisIds.length,
    pgCount: pgIds.length,
    onlyInRedis: redisIds.filter(id => !pgSet.has(id)),
    onlyInPg: pgIds.filter(id => !redisSet.has(id)),
    ok: redisIds.every(id => pgSet.has(id)),
  };
}

async function checkMessages(): Promise<CheckResult> {
  const streamKeys = await scanStreamKeys("konoha:agent:*");
  let redisCount = 0;
  for (const key of streamKeys) {
    const n = await redis.xlen(key);
    redisCount += n;
  }
  const pgRows = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM konoha_messages`;
  const pgCount = pgRows[0]?.n ?? 0;

  return {
    entity: "messages",
    redisCount,
    pgCount,
    onlyInRedis: [],
    onlyInPg: [],
    ok: pgCount >= redisCount,
  };
}

const STRICT = process.argv.includes("--strict");
const FIX = process.argv.includes("--fix");

// Warn if onlyInPg exceeds this fraction of redisCount.
// At 1.0 (100%) PG has 2x Redis — possible phantom duplicates from dual-write.
// In --strict mode, threshold is lowered to catch earlier.
const PG_BLOAT_THRESHOLD = parseFloat(process.env.PG_BLOAT_THRESHOLD ?? (STRICT ? "0.5" : "1.0"));

// Returns true if a bloat threshold was exceeded for this entity.
function printResult(r: CheckResult): boolean {
  const status = r.ok ? "OK" : "MISMATCH";
  console.log(`\n[${status}] ${r.entity}: Redis=${r.redisCount} PG=${r.pgCount}`);
  if (r.onlyInRedis.length > 0) {
    // CRITICAL: these records would be lost if Redis were turned off
    console.log(`  !! Only in Redis (${r.onlyInRedis.length}): ${r.onlyInRedis.slice(0, 5).join(", ")}${r.onlyInRedis.length > 5 ? " ..." : ""}`);
  }
  let bloat = false;
  let onlyInPgIsError = false;
  if (r.onlyInPg.length > 0) {
    if (STRICT) {
      console.log(`  !! Only in PG (${r.onlyInPg.length}) [STRICT mode]: ${r.onlyInPg.slice(0, 5).join(", ")}${r.onlyInPg.length > 5 ? " ..." : ""}`);
      onlyInPgIsError = true;
    } else {
      console.log(`  -- Only in PG (${r.onlyInPg.length}) [archived/historical, OK]: ${r.onlyInPg.slice(0, 3).join(", ")}${r.onlyInPg.length > 3 ? " ..." : ""}`);
    }
    if (r.redisCount > 0 && r.onlyInPg.length > r.redisCount * PG_BLOAT_THRESHOLD) {
      const pct = Math.round((r.onlyInPg.length / r.redisCount) * 100);
      console.log(`  ⚠ BLOAT WARNING: onlyInPg (${r.onlyInPg.length}) is ${pct}% of redisCount (${PG_BLOAT_THRESHOLD * 100}% threshold).`);
      console.log(`    Action: bun run scripts/migrate-redis-to-pg.ts --dry-run`);
      bloat = true;
    }
  }
  return { bloat, onlyInPgIsError };
}

async function main(): Promise<void> {
  console.log("=== Konoha PG Verification ===");
  console.log(`DB: ${DATABASE_URL.replace(/:\/\/[^@]+@/, "://<creds>@")}`);

  try {
    const results = await Promise.all([
      checkCases(),
      checkWorkItems(),
      checkWorkflows(),
      checkRoles(),
      checkDocs(),
      checkReminders(),
      checkAgents(),
      checkMessages(),
    ]);

    let allOk = true;
    let hasBloat = false;
    let hasOnlyInPg = false;
    for (const r of results) {
      const { bloat, onlyInPgIsError } = printResult(r);
      if (bloat) hasBloat = true;
      if (onlyInPgIsError) hasOnlyInPg = true;
      if (!r.ok) allOk = false;
    }

    if (!allOk || (STRICT && hasOnlyInPg)) {
      if (STRICT && hasOnlyInPg && allOk) {
        console.log("\n=== RESULT: MISMATCH — onlyInPG records found (--strict mode) ===");
      } else {
        console.log("\n=== RESULT: MISMATCH — discrepancies found ===");
      }
      if (FIX) {
        console.log("\n--fix mode: run migrate-redis-to-pg.ts to sync onlyInRedis records");
        console.log("  bun run scripts/migrate-redis-to-pg.ts");
      }
      process.exit(1);
    } else if (hasBloat) {
      console.log("\n=== RESULT: BLOAT — sync OK but PG exceeds bloat threshold ===");
      console.log("    Investigate: bun run scripts/migrate-redis-to-pg.ts --dry-run");
      process.exit(2);
    } else {
      console.log("\n=== RESULT: OK — Redis and PG are in sync ===");
      process.exit(0);
    }
  } finally {
    redis.disconnect();
    await sql.end();
  }
}

main().catch(e => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
