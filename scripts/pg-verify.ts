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

const DATABASE_URL = process.env.DATABASE_URL ||
  "postgres://konoha:konoha2026@127.0.0.1:5432/konoha";

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

// Warn if onlyInPg exceeds this fraction of redisCount.
// At 1.0 (100%) PG has 2x Redis — possible phantom duplicates from dual-write.
const PG_BLOAT_THRESHOLD = parseFloat(process.env.PG_BLOAT_THRESHOLD ?? "1.0");

function printResult(r: CheckResult): void {
  const status = r.ok ? "OK" : "MISMATCH";
  console.log(`\n[${status}] ${r.entity}: Redis=${r.redisCount} PG=${r.pgCount}`);
  if (r.onlyInRedis.length > 0) {
    // CRITICAL: these records would be lost if Redis were turned off
    console.log(`  !! Only in Redis (${r.onlyInRedis.length}): ${r.onlyInRedis.slice(0, 5).join(", ")}${r.onlyInRedis.length > 5 ? " ..." : ""}`);
  }
  if (r.onlyInPg.length > 0) {
    // INFO: archived/historical data in PG no longer active in Redis — acceptable pre-migration
    console.log(`  -- Only in PG (${r.onlyInPg.length}) [archived/historical, OK]: ${r.onlyInPg.slice(0, 3).join(", ")}${r.onlyInPg.length > 3 ? " ..." : ""}`);
    // WARN: onlyInPg exceeds threshold — may indicate phantom duplicates from dual-write
    if (r.redisCount > 0 && r.onlyInPg.length > r.redisCount * PG_BLOAT_THRESHOLD) {
      const pct = Math.round((r.onlyInPg.length / r.redisCount) * 100);
      console.log(`  ⚠ BLOAT WARNING: onlyInPg (${r.onlyInPg.length}) is ${pct}% of redisCount — may include phantom duplicates, not just archives. Run migrate script to investigate.`);
    }
  }
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
    ]);

    let allOk = true;
    for (const r of results) {
      printResult(r);
      if (!r.ok) allOk = false;
    }

    console.log("\n" + (allOk ? "=== RESULT: OK — Redis and PG are in sync ===" : "=== RESULT: MISMATCH — discrepancies found ==="));
    process.exit(allOk ? 0 : 1);
  } finally {
    redis.disconnect();
    await sql.end();
  }
}

main().catch(e => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
