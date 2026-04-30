#!/usr/bin/env bun
import Redis from "ioredis";
import postgres from "postgres";
import { getDatabaseUrl } from "../src/storage/database-url";

export type RetentionEntity = "cases" | "work_items" | "workflows" | "documents" | "agents" | "reminders";

export interface PgOnlyRow {
  entity: RetentionEntity;
  id: string;
  status: string | null;
  process: string | null;
  created_at: Date | string | null;
  updated_at: Date | string | null;
}

export interface RetentionGroup {
  entity: RetentionEntity;
  candidate: string;
  status: string;
  process_prefix: string;
  id_prefix: string;
  age_bucket: string;
  would_delete_count: number;
  sample_ids: string[];
}

interface RenderOptions {
  limit: number | null;
}

interface EntityConfig {
  entity: RetentionEntity;
  table: string;
  idColumn: string;
  redisIds: (redis: Redis) => Promise<string[]>;
  statusColumn?: string;
  processColumn?: string;
}

const ENTITY_CONFIGS: EntityConfig[] = [
  { entity: "cases", table: "cases", idColumn: "case_id", redisIds: redis => redis.zrange("konoha:cases:all", 0, -1), statusColumn: "status", processColumn: "process_id" },
  { entity: "work_items", table: "work_items", idColumn: "id", redisIds: redis => redis.zrange("konoha:workitems:all", 0, -1), statusColumn: "status", processColumn: "process_id" },
  { entity: "workflows", table: "workflows", idColumn: "id", redisIds: redis => redis.smembers("konoha:workflow:index"), statusColumn: "status", processColumn: "parent_id" },
  { entity: "documents", table: "documents", idColumn: "id", redisIds: redis => redis.zrange("konoha:docs:all", 0, -1) },
  { entity: "agents", table: "konoha_agents", idColumn: "id", redisIds: redis => redis.hkeys("konoha:registry"), statusColumn: "status" },
  { entity: "reminders", table: "reminders", idColumn: "id", redisIds: redis => redis.zrange("konoha:reminders:all", 0, -1), statusColumn: "status", processColumn: "process_id" },
];

const GENERATED_PREFIXES = [
  "act-wf",
  "assistant-start",
  "autonomy-eval",
  "eepc",
  "operator-eval",
  "or-gw",
  "test",
  "xor-gw",
];

const GENERATED_RE = /^(act-wf|assistant-start|autonomy-eval|eepc|operator-eval|or-gw|test|xor-gw)(?:-|\d|$)/;
const COMPLETED_STATUSES = new Set(["done", "completed", "sent", "closed", "archived"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function asDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function ageBucket(value: Date | string | null, now = new Date()): string {
  const d = asDate(value);
  if (!d) return "unknown";
  const ageMs = Math.max(0, now.getTime() - d.getTime());
  const dayMs = 24 * 60 * 60 * 1000;
  if (ageMs < dayMs) return "<1d";
  if (ageMs < 7 * dayMs) return "1-7d";
  if (ageMs < 30 * dayMs) return "7-30d";
  return "30d+";
}

export function idPrefix(id: string): string {
  if (UUID_RE.test(id)) return "uuid";
  const match = id.match(/^[a-zA-Z]+(?:-[a-zA-Z]+)*/);
  return match?.[0] ?? id.slice(0, 12);
}

export function processPrefix(process: string | null): string {
  if (!process) return "none";
  for (const prefix of GENERATED_PREFIXES) {
    if (process.startsWith(prefix)) return prefix;
  }
  return idPrefix(process);
}

function isOld(row: PgOnlyRow, now: Date, minAgeDays: number): boolean {
  const d = asDate(row.updated_at) ?? asDate(row.created_at);
  if (!d) return false;
  return now.getTime() - d.getTime() >= minAgeDays * 24 * 60 * 60 * 1000;
}

export function classifyRetentionCandidate(row: PgOnlyRow, now = new Date()): string {
  const status = row.status ?? "unknown";
  const id = row.id;
  const process = row.process ?? "";

  if (row.entity === "agents" && status === "offline" && (/^debug-/.test(id) || id.endsWith("-startup-check"))) {
    return "safe_candidate:debug_agent";
  }

  if (row.entity === "workflows" && status === "draft" && GENERATED_RE.test(id)) {
    return "safe_candidate:generated_draft_workflow";
  }

  if ((row.entity === "cases" || row.entity === "work_items")
    && COMPLETED_STATUSES.has(status)
    && (GENERATED_RE.test(process) || GENERATED_RE.test(id))
    && isOld(row, now, 7)) {
    return `safe_candidate:old_completed_${row.entity}`;
  }

  if (row.entity === "reminders" && COMPLETED_STATUSES.has(status) && isOld(row, now, 30)) {
    return "safe_candidate:old_completed_reminder";
  }

  if (row.entity === "documents" && GENERATED_RE.test(id) && isOld(row, now, 30)) {
    return "safe_candidate:generated_document";
  }

  return "review";
}

export function groupRetentionRows(rows: PgOnlyRow[], now = new Date()): RetentionGroup[] {
  const groups = new Map<string, RetentionGroup>();
  for (const row of rows) {
    const group: RetentionGroup = {
      entity: row.entity,
      candidate: classifyRetentionCandidate(row, now),
      status: row.status ?? "unknown",
      process_prefix: processPrefix(row.process),
      id_prefix: idPrefix(row.id),
      age_bucket: ageBucket(row.updated_at ?? row.created_at, now),
      would_delete_count: 0,
      sample_ids: [],
    };
    const key = JSON.stringify([
      group.entity,
      group.candidate,
      group.status,
      group.process_prefix,
      group.id_prefix,
      group.age_bucket,
    ]);
    const existing = groups.get(key) ?? group;
    existing.would_delete_count += 1;
    if (existing.sample_ids.length < 5) existing.sample_ids.push(row.id);
    groups.set(key, existing);
  }
  return [...groups.values()].sort((a, b) =>
    b.would_delete_count - a.would_delete_count
    || a.entity.localeCompare(b.entity)
    || a.candidate.localeCompare(b.candidate)
  );
}

async function loadPgRows(sql: postgres.Sql, config: EntityConfig): Promise<PgOnlyRow[]> {
  const statusExpr = config.statusColumn ? sql`${sql(config.statusColumn)}::text` : sql`NULL::text`;
  const processExpr = config.processColumn ? sql`${sql(config.processColumn)}::text` : sql`NULL::text`;
  const rows = await sql<Array<Omit<PgOnlyRow, "entity">>>`
    SELECT
      ${sql(config.idColumn)}::text AS id,
      ${statusExpr} AS status,
      ${processExpr} AS process,
      created_at,
      updated_at
    FROM ${sql(config.table)}
  `;
  return rows.map(row => ({ ...row, entity: config.entity }));
}

function parseLimit(): number | null {
  if (process.argv.includes("--all")) return null;
  const arg = process.argv.find(value => value.startsWith("--limit="));
  if (!arg) return 120;
  const n = Number(arg.slice("--limit=".length));
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 120;
}

function renderText(report: {
  entityCounts: Array<{ entity: RetentionEntity; redisCount: number; pgCount: number; onlyInRedis: string[]; onlyInPg: number }>;
  groups: RetentionGroup[];
}, options: RenderOptions) {
  console.log("=== Konoha PG-only retention report (dry-run) ===");
  console.log("Mode: read-only SELECTs only; no DELETE/UPDATE is executed.");
  console.log("");

  for (const count of report.entityCounts) {
    const status = count.onlyInRedis.length > 0 ? "MISMATCH" : "OK";
    console.log(`[${status}] ${count.entity}: Redis=${count.redisCount} PG=${count.pgCount} onlyInRedis=${count.onlyInRedis.length} onlyInPg=${count.onlyInPg}`);
    if (count.onlyInRedis.length > 0) {
      console.log(`  HARD FAIL onlyInRedis: ${count.onlyInRedis.slice(0, 5).join(", ")}${count.onlyInRedis.length > 5 ? " ..." : ""}`);
    }
  }

  console.log("\nGroups:");
  if (report.groups.length === 0) {
    console.log("  No PG-only rows found.");
    return;
  }
  const groups = options.limit === null ? report.groups : report.groups.slice(0, options.limit);
  for (const group of groups) {
    console.log(`- entity=${group.entity} candidate=${group.candidate} status=${group.status} process_prefix=${group.process_prefix} id_prefix=${group.id_prefix} age=${group.age_bucket} would_delete_count=${group.would_delete_count}`);
    console.log(`  samples=${group.sample_ids.join(", ")}`);
  }
  if (groups.length < report.groups.length) {
    console.log(`  ... ${report.groups.length - groups.length} more groups omitted; rerun with --all or --json for the full dry-run report.`);
  }
}

async function main() {
  const json = process.argv.includes("--json");
  const redis = new Redis({ host: "127.0.0.1", port: 6379, db: 0, lazyConnect: false });
  const sql = postgres(getDatabaseUrl(), { max: 3, idle_timeout: 10, connect_timeout: 5, onnotice: () => {} });

  try {
    const allPgOnlyRows: PgOnlyRow[] = [];
    const entityCounts = [];
    let hardFail = false;

    for (const config of ENTITY_CONFIGS) {
      const [redisIds, pgRows] = await Promise.all([
        config.redisIds(redis),
        loadPgRows(sql, config),
      ]);
      const redisSet = new Set(redisIds);
      const pgSet = new Set(pgRows.map(row => row.id));
      const onlyInRedis = redisIds.filter(id => !pgSet.has(id));
      const onlyInPgRows = pgRows.filter(row => !redisSet.has(row.id));
      if (onlyInRedis.length > 0) hardFail = true;
      allPgOnlyRows.push(...onlyInPgRows);
      entityCounts.push({
        entity: config.entity,
        redisCount: redisIds.length,
        pgCount: pgRows.length,
        onlyInRedis,
        onlyInPg: onlyInPgRows.length,
      });
    }

    const report = { entityCounts, groups: groupRetentionRows(allPgOnlyRows) };
    if (json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      renderText(report, { limit: parseLimit() });
    }
    process.exit(hardFail ? 1 : 0);
  } finally {
    redis.disconnect();
    await sql.end();
  }
}

if (import.meta.main) {
  main().catch(error => {
    console.error(`Fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
