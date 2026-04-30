import Redis from "ioredis";
import postgres from "postgres";
import { getDatabaseUrl } from "../storage/database-url";

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

export interface RetentionEntityCount {
  entity: RetentionEntity;
  redisCount: number;
  pgCount: number;
  onlyInRedis: string[];
  onlyInPg: number;
}

export interface PgOnlyRetentionReport {
  mode: "dry_run";
  generated_at: string;
  hard_fail: boolean;
  entityCounts: RetentionEntityCount[];
  groups: RetentionGroup[];
}

export interface ActionRetentionReport extends PgOnlyRetentionReport {
  omitted_groups: number;
}

export interface RetentionCleanupCandidate {
  entity: RetentionEntity;
  id: string;
  candidate: string;
  status: string;
  process: string | null;
  age_bucket: string;
  created_at: string | null;
  updated_at: string | null;
}

export interface RetentionCleanupPreview {
  mode: "preview";
  generated_at: string;
  hard_fail: boolean;
  blocked_reason?: string;
  total_candidates: number;
  omitted_candidates: number;
  candidates: RetentionCleanupCandidate[];
}

export interface RetentionCleanupApplyRequest {
  entity: RetentionEntity;
  id: string;
  candidate: string;
}

export interface RetentionCleanupRejectedCandidate {
  entity?: string;
  id?: string;
  candidate?: string;
  reason: string;
}

export interface RetentionCleanupApplyResult {
  mode: "apply";
  generated_at: string;
  applied: boolean;
  hard_fail: boolean;
  blocked_reason?: string;
  requested_count: number;
  approved_count: number;
  deleted_count: number;
  max_batch_size: number;
  deleted: RetentionCleanupCandidate[];
  rejected: RetentionCleanupRejectedCandidate[];
}

interface RetentionDataset {
  report: PgOnlyRetentionReport;
  pgOnlyRows: PgOnlyRow[];
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
export const MAX_CLEANUP_APPLY_BATCH = 200;

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

function isoOrNull(value: Date | string | null): string | null {
  const d = asDate(value);
  return d ? d.toISOString() : null;
}

function cleanupCandidateFromRow(row: PgOnlyRow, candidate: string, now: Date): RetentionCleanupCandidate {
  return {
    entity: row.entity,
    id: row.id,
    candidate,
    status: row.status ?? "unknown",
    process: row.process,
    age_bucket: ageBucket(row.updated_at ?? row.created_at, now),
    created_at: isoOrNull(row.created_at),
    updated_at: isoOrNull(row.updated_at),
  };
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

async function collectPgOnlyRetentionDataset(
  redis: Redis,
  sql: postgres.Sql,
  now = new Date(),
): Promise<RetentionDataset> {
  const allPgOnlyRows: PgOnlyRow[] = [];
  const entityCounts: RetentionEntityCount[] = [];
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

  return {
    report: {
      mode: "dry_run",
      generated_at: now.toISOString(),
      hard_fail: hardFail,
      entityCounts,
      groups: groupRetentionRows(allPgOnlyRows, now),
    },
    pgOnlyRows: allPgOnlyRows,
  };
}

export async function collectPgOnlyRetentionReport(
  redis: Redis,
  sql: postgres.Sql,
  now = new Date(),
): Promise<PgOnlyRetentionReport> {
  return (await collectPgOnlyRetentionDataset(redis, sql, now)).report;
}

export async function buildPgOnlyRetentionReport(now = new Date()): Promise<PgOnlyRetentionReport> {
  const redis = new Redis({ host: "127.0.0.1", port: 6379, db: 0, lazyConnect: false });
  const sql = postgres(getDatabaseUrl(), { max: 3, idle_timeout: 10, connect_timeout: 5, onnotice: () => {} });

  try {
    return await collectPgOnlyRetentionReport(redis, sql, now);
  } finally {
    redis.disconnect();
    await sql.end();
  }
}

export function buildCleanupPreviewFromRows(
  rows: PgOnlyRow[],
  options: { generatedAt: string; hardFail: boolean; limit?: number | null; now?: Date },
): RetentionCleanupPreview {
  const limit = options.limit === undefined ? 200 : options.limit;
  const now = options.now ?? new Date(options.generatedAt);
  const allCandidates = rows
    .map(row => ({ row, candidate: classifyRetentionCandidate(row, now) }))
    .filter(item => item.candidate.startsWith("safe_candidate:"))
    .sort((a, b) =>
      a.row.entity.localeCompare(b.row.entity)
      || a.candidate.localeCompare(b.candidate)
      || a.row.id.localeCompare(b.row.id)
    );

  const selected = limit === null ? allCandidates : allCandidates.slice(0, Math.max(0, Math.floor(limit)));
  const blockedReason = options.hardFail
    ? "Redis-only rows detected; cleanup preview is blocked until Redis/Postgres consistency is restored."
    : undefined;

  return {
    mode: "preview",
    generated_at: options.generatedAt,
    hard_fail: options.hardFail,
    ...(blockedReason ? { blocked_reason: blockedReason } : {}),
    total_candidates: allCandidates.length,
    omitted_candidates: allCandidates.length - selected.length,
    candidates: options.hardFail ? [] : selected.map(({ row, candidate }) => cleanupCandidateFromRow(row, candidate, now)),
  };
}

export async function buildPgOnlyRetentionCleanupPreview(
  options: { limit?: number | null; now?: Date } = {},
): Promise<RetentionCleanupPreview> {
  const redis = new Redis({ host: "127.0.0.1", port: 6379, db: 0, lazyConnect: false });
  const sql = postgres(getDatabaseUrl(), { max: 3, idle_timeout: 10, connect_timeout: 5, onnotice: () => {} });
  const now = options.now ?? new Date();

  try {
    const dataset = await collectPgOnlyRetentionDataset(redis, sql, now);
    return buildCleanupPreviewFromRows(dataset.pgOnlyRows, {
      generatedAt: dataset.report.generated_at,
      hardFail: dataset.report.hard_fail,
      limit: options.limit,
      now,
    });
  } finally {
    redis.disconnect();
    await sql.end();
  }
}

function entityConfig(entity: RetentionEntity): EntityConfig {
  const config = ENTITY_CONFIGS.find(item => item.entity === entity);
  if (!config) throw new Error(`Unknown retention entity: ${entity}`);
  return config;
}

function safeCandidateIndex(rows: PgOnlyRow[], now: Date): Map<string, RetentionCleanupCandidate> {
  const index = new Map<string, RetentionCleanupCandidate>();
  for (const row of rows) {
    const candidate = classifyRetentionCandidate(row, now);
    if (!candidate.startsWith("safe_candidate:")) continue;
    index.set(`${row.entity}:${row.id}`, cleanupCandidateFromRow(row, candidate, now));
  }
  return index;
}

function isApplyRequest(value: unknown): value is RetentionCleanupApplyRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.entity === "string"
    && ENTITY_CONFIGS.some(config => config.entity === item.entity)
    && typeof item.id === "string"
    && typeof item.candidate === "string";
}

export function buildCleanupApplyPlanFromRows(
  rows: PgOnlyRow[],
  requests: unknown[],
  options: { generatedAt: string; hardFail: boolean; confirmed: boolean; maxBatchSize?: number; now?: Date },
): RetentionCleanupApplyResult {
  const now = options.now ?? new Date(options.generatedAt);
  const maxBatchSize = options.maxBatchSize ?? MAX_CLEANUP_APPLY_BATCH;
  const rejected: RetentionCleanupRejectedCandidate[] = [];
  const approved: RetentionCleanupCandidate[] = [];
  const safeIndex = safeCandidateIndex(rows, now);
  const seen = new Set<string>();

  if (!options.confirmed) {
    return {
      mode: "apply",
      generated_at: options.generatedAt,
      applied: false,
      hard_fail: options.hardFail,
      blocked_reason: "cleanup_apply requires confirm=true",
      requested_count: requests.length,
      approved_count: 0,
      deleted_count: 0,
      max_batch_size: maxBatchSize,
      deleted: [],
      rejected,
    };
  }

  if (options.hardFail) {
    return {
      mode: "apply",
      generated_at: options.generatedAt,
      applied: false,
      hard_fail: true,
      blocked_reason: "Redis-only rows detected; cleanup_apply is blocked until Redis/Postgres consistency is restored.",
      requested_count: requests.length,
      approved_count: 0,
      deleted_count: 0,
      max_batch_size: maxBatchSize,
      deleted: [],
      rejected,
    };
  }

  if (requests.length === 0) {
    rejected.push({ reason: "at least one candidate is required" });
  }
  if (requests.length > maxBatchSize) {
    rejected.push({ reason: `batch size ${requests.length} exceeds max ${maxBatchSize}` });
  }

  for (const value of requests) {
    if (!isApplyRequest(value)) {
      rejected.push({ reason: "candidate must include valid entity, id, and candidate fields" });
      continue;
    }
    const key = `${value.entity}:${value.id}`;
    if (seen.has(key)) {
      rejected.push({ entity: value.entity, id: value.id, candidate: value.candidate, reason: "duplicate candidate" });
      continue;
    }
    seen.add(key);

    const current = safeIndex.get(key);
    if (!current) {
      rejected.push({ entity: value.entity, id: value.id, candidate: value.candidate, reason: "not present in current safe PG-only candidate set" });
      continue;
    }
    if (current.candidate !== value.candidate) {
      rejected.push({ entity: value.entity, id: value.id, candidate: value.candidate, reason: `candidate mismatch; current=${current.candidate}` });
      continue;
    }
    approved.push(current);
  }

  if (rejected.length > 0) {
    return {
      mode: "apply",
      generated_at: options.generatedAt,
      applied: false,
      hard_fail: false,
      blocked_reason: "cleanup_apply is all-or-nothing; rejected candidates must be fixed before retry",
      requested_count: requests.length,
      approved_count: 0,
      deleted_count: 0,
      max_batch_size: maxBatchSize,
      deleted: [],
      rejected,
    };
  }

  return {
    mode: "apply",
    generated_at: options.generatedAt,
    applied: false,
    hard_fail: false,
    requested_count: requests.length,
    approved_count: approved.length,
    deleted_count: 0,
    max_batch_size: maxBatchSize,
    deleted: approved,
    rejected: [],
  };
}

async function verifyNotInRedis(redis: Redis, candidates: RetentionCleanupCandidate[]): Promise<RetentionCleanupRejectedCandidate[]> {
  const rejected: RetentionCleanupRejectedCandidate[] = [];
  const byEntity = new Map<RetentionEntity, Set<string>>();
  for (const candidate of candidates) {
    const ids = byEntity.get(candidate.entity) ?? new Set<string>();
    ids.add(candidate.id);
    byEntity.set(candidate.entity, ids);
  }

  for (const [entity, ids] of byEntity) {
    const config = entityConfig(entity);
    const redisIds = new Set(await config.redisIds(redis));
    for (const id of ids) {
      if (redisIds.has(id)) {
        rejected.push({ entity, id, reason: "candidate reappeared in Redis before delete" });
      }
    }
  }
  return rejected;
}

async function deletePgOnlyCandidates(sql: postgres.Sql, candidates: RetentionCleanupCandidate[]): Promise<RetentionCleanupCandidate[]> {
  const deleted: RetentionCleanupCandidate[] = [];
  for (const candidate of candidates) {
    const config = entityConfig(candidate.entity);
    const rows = await sql<Array<{ id: string }>>`
      DELETE FROM ${sql(config.table)}
      WHERE ${sql(config.idColumn)} = ${candidate.id}
      RETURNING ${sql(config.idColumn)}::text AS id
    `;
    if (rows.length > 0) deleted.push(candidate);
  }
  return deleted;
}

export async function buildPgOnlyRetentionCleanupApply(
  options: { candidates: unknown[]; confirm: boolean; now?: Date; maxBatchSize?: number },
): Promise<RetentionCleanupApplyResult> {
  const redis = new Redis({ host: "127.0.0.1", port: 6379, db: 0, lazyConnect: false });
  const sql = postgres(getDatabaseUrl(), { max: 3, idle_timeout: 10, connect_timeout: 5, onnotice: () => {} });
  const now = options.now ?? new Date();

  try {
    const dataset = await collectPgOnlyRetentionDataset(redis, sql, now);
    const plan = buildCleanupApplyPlanFromRows(dataset.pgOnlyRows, options.candidates, {
      generatedAt: dataset.report.generated_at,
      hardFail: dataset.report.hard_fail,
      confirmed: options.confirm,
      maxBatchSize: options.maxBatchSize,
      now,
    });
    if (plan.blocked_reason || plan.deleted.length === 0) return plan;

    const redisRejected = await verifyNotInRedis(redis, plan.deleted);
    if (redisRejected.length > 0) {
      return {
        ...plan,
        applied: false,
        blocked_reason: "cleanup_apply is all-or-nothing; one or more candidates reappeared in Redis",
        approved_count: 0,
        deleted_count: 0,
        deleted: [],
        rejected: redisRejected,
      };
    }

    const deleted = await deletePgOnlyCandidates(sql, plan.deleted);
    return {
      ...plan,
      applied: true,
      deleted,
      deleted_count: deleted.length,
    };
  } finally {
    redis.disconnect();
    await sql.end();
  }
}

export function retentionReportForAction(report: PgOnlyRetentionReport, limit: number | null = 120): ActionRetentionReport {
  const groups = limit === null ? report.groups : report.groups.slice(0, Math.max(0, Math.floor(limit)));
  return {
    ...report,
    groups,
    omitted_groups: report.groups.length - groups.length,
  };
}

export function renderRetentionReportText(report: PgOnlyRetentionReport, limit: number | null = 120): string {
  const lines: string[] = [
    "=== Konoha PG-only retention report (dry-run) ===",
    "Mode: read-only SELECTs only; no DELETE/UPDATE is executed.",
    "",
  ];

  for (const count of report.entityCounts) {
    const status = count.onlyInRedis.length > 0 ? "MISMATCH" : "OK";
    lines.push(`[${status}] ${count.entity}: Redis=${count.redisCount} PG=${count.pgCount} onlyInRedis=${count.onlyInRedis.length} onlyInPg=${count.onlyInPg}`);
    if (count.onlyInRedis.length > 0) {
      lines.push(`  HARD FAIL onlyInRedis: ${count.onlyInRedis.slice(0, 5).join(", ")}${count.onlyInRedis.length > 5 ? " ..." : ""}`);
    }
  }

  lines.push("", "Groups:");
  if (report.groups.length === 0) {
    lines.push("  No PG-only rows found.");
    return lines.join("\n");
  }

  const groups = limit === null ? report.groups : report.groups.slice(0, limit);
  for (const group of groups) {
    lines.push(`- entity=${group.entity} candidate=${group.candidate} status=${group.status} process_prefix=${group.process_prefix} id_prefix=${group.id_prefix} age=${group.age_bucket} would_delete_count=${group.would_delete_count}`);
    lines.push(`  samples=${group.sample_ids.join(", ")}`);
  }
  if (groups.length < report.groups.length) {
    lines.push(`  ... ${report.groups.length - groups.length} more groups omitted; rerun with --all or --json for the full dry-run report.`);
  }
  return lines.join("\n");
}
