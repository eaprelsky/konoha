import {
  buildPgOnlyRetentionReport,
  type PgOnlyRetentionReport,
  type RetentionEntity,
  type RetentionGroup,
} from "./retention/report";
import { PG_READ_ENTITIES, resolvePgReadFlags, type PgReadEntity } from "./storage/pg-read-flags";

export type PgReadReadinessStatus = "ready" | "blocked" | "pg_primary";

export interface PgReadReadinessBlocker {
  code: "ONLY_IN_REDIS" | "PG_ONLY_RETENTION_REQUIRED" | "PG_ONLY_MANUAL_REVIEW";
  severity: "blocker";
  message: string;
  count: number;
  sample_ids?: string[];
}

export interface PgReadEntityReadiness {
  entity: RetentionEntity;
  status: PgReadReadinessStatus;
  pg_read_path: "implemented" | "pg_primary";
  pg_read_enabled: boolean;
  blockers: PgReadReadinessBlocker[];
  evidence: {
    redis_count: number;
    pg_count: number;
    only_in_redis_count: number;
    only_in_pg_count: number;
    safe_cleanup_candidate_count: number;
    manual_review_count: number;
  };
  retention_groups: Array<Pick<RetentionGroup,
    "candidate" | "retention_class" | "disposition" | "safe_cleanup_candidate" | "reason" | "would_delete_count" | "sample_ids"
  >>;
  recommendation: string;
}

export interface PgReadReadinessReport {
  mode: "pg_read_readiness";
  schema_version: 1;
  generated_at: string;
  legacy_pg_read_enabled: boolean;
  pg_read_enabled: boolean;
  enabled_entities: PgReadEntity[];
  rollout_status: "safe" | "unsafe";
  overall_status: "ready" | "blocked";
  summary: {
    total_entities: number;
    ready: number;
    blocked: number;
    pg_primary: number;
    enabled: number;
    enabled_blocked: number;
  };
  entities: PgReadEntityReadiness[];
}

const PG_PRIMARY_ENTITIES = new Set<RetentionEntity>(["agents"]);

function groupsForEntity(report: PgOnlyRetentionReport, entity: RetentionEntity): RetentionGroup[] {
  return report.groups.filter(group => group.entity === entity);
}

function groupCount(groups: RetentionGroup[], predicate: (group: RetentionGroup) => boolean): number {
  return groups
    .filter(predicate)
    .reduce((total, group) => total + group.would_delete_count, 0);
}

function blockerForOnlyInRedis(count: NonNullable<PgOnlyRetentionReport["entityCounts"][number]>): PgReadReadinessBlocker | null {
  if (count.onlyInRedis.length === 0) return null;
  return {
    code: "ONLY_IN_REDIS",
    severity: "blocker",
    count: count.onlyInRedis.length,
    sample_ids: count.onlyInRedis.slice(0, 5),
    message: "Redis-primary rows are missing from PostgreSQL shadow storage; PG_READ would lose active data.",
  };
}

function blockerForPgOnly(groups: RetentionGroup[], manualReviewCount: number, safeCleanupCount: number): PgReadReadinessBlocker[] {
  const blockers: PgReadReadinessBlocker[] = [];
  if (manualReviewCount > 0) {
    blockers.push({
      code: "PG_ONLY_MANUAL_REVIEW",
      severity: "blocker",
      count: manualReviewCount,
      sample_ids: groups.filter(group => group.disposition === "manual_review").flatMap(group => group.sample_ids).slice(0, 5),
      message: "PostgreSQL has PG-only rows that require manual review before entity-level PG_READ can be enabled.",
    });
  }
  if (safeCleanupCount > 0) {
    blockers.push({
      code: "PG_ONLY_RETENTION_REQUIRED",
      severity: "blocker",
      count: safeCleanupCount,
      sample_ids: groups.filter(group => group.safe_cleanup_candidate).flatMap(group => group.sample_ids).slice(0, 5),
      message: "PostgreSQL has PG-only safe cleanup candidates; clean or filter them before entity-level PG_READ.",
    });
  }
  return blockers;
}

function recommendationFor(entity: RetentionEntity, status: PgReadReadinessStatus, blockers: PgReadReadinessBlocker[]): string {
  if (status === "pg_primary") return `${entity} already uses PostgreSQL as the primary source of truth; PG_READ flag does not apply.`;
  if (status === "ready") return `${entity} is eligible for an entity-scoped PG_READ rollout with normal latency monitoring.`;
  if (blockers.some(blocker => blocker.code === "ONLY_IN_REDIS")) {
    return `Backfill or repair ${entity} Redis-only rows before PG_READ.`;
  }
  return `Run retention cleanup preview/apply or add explicit filtering for ${entity} PG-only rows before PG_READ.`;
}

export function buildPgReadReadinessReportFromRetentionReport(
  report: PgOnlyRetentionReport,
  options: { pgReadEnabled?: boolean; env?: NodeJS.ProcessEnv } = {},
): PgReadReadinessReport {
  const flagConfig = resolvePgReadFlags(options.env);
  const byEntity = new Map(report.entityCounts.map(count => [count.entity, count]));
  const entities: PgReadEntityReadiness[] = [];
  const orderedEntities = [...PG_READ_ENTITIES, ...[...PG_PRIMARY_ENTITIES].filter(entity => byEntity.has(entity))];

  for (const entity of orderedEntities) {
    const count = byEntity.get(entity);
    if (!count) continue;
    const groups = groupsForEntity(report, entity);
    const safeCleanupCount = groupCount(groups, group => group.safe_cleanup_candidate);
    const manualReviewCount = groupCount(groups, group => group.disposition === "manual_review");
    const pgPrimary = PG_PRIMARY_ENTITIES.has(entity);
    const pgReadEnabled = pgPrimary ? false : flagConfig.entity_flags[entity as PgReadEntity] === true;
    const blockers = pgPrimary
      ? []
      : [
          blockerForOnlyInRedis(count),
          ...blockerForPgOnly(groups, manualReviewCount, safeCleanupCount),
        ].filter(Boolean) as PgReadReadinessBlocker[];
    const status: PgReadReadinessStatus = pgPrimary ? "pg_primary" : blockers.length === 0 ? "ready" : "blocked";

    entities.push({
      entity,
      status,
      pg_read_path: pgPrimary ? "pg_primary" : "implemented",
      pg_read_enabled: pgReadEnabled,
      blockers,
      evidence: {
        redis_count: count.redisCount,
        pg_count: count.pgCount,
        only_in_redis_count: count.onlyInRedis.length,
        only_in_pg_count: count.onlyInPg,
        safe_cleanup_candidate_count: safeCleanupCount,
        manual_review_count: manualReviewCount,
      },
      retention_groups: groups.slice(0, 20).map(group => ({
        candidate: group.candidate,
        retention_class: group.retention_class,
        disposition: group.disposition,
        safe_cleanup_candidate: group.safe_cleanup_candidate,
        reason: group.reason,
        would_delete_count: group.would_delete_count,
        sample_ids: group.sample_ids,
      })),
      recommendation: recommendationFor(entity, status, blockers),
    });
  }

  const summary = {
    total_entities: entities.length,
    ready: entities.filter(entity => entity.status === "ready").length,
    blocked: entities.filter(entity => entity.status === "blocked").length,
    pg_primary: entities.filter(entity => entity.status === "pg_primary").length,
    enabled: entities.filter(entity => entity.pg_read_enabled).length,
    enabled_blocked: entities.filter(entity => entity.pg_read_enabled && entity.status === "blocked").length,
  };

  return {
    mode: "pg_read_readiness",
    schema_version: 1,
    generated_at: report.generated_at,
    legacy_pg_read_enabled: options.pgReadEnabled ?? flagConfig.legacy_global_enabled,
    pg_read_enabled: options.pgReadEnabled ?? flagConfig.legacy_global_enabled,
    enabled_entities: flagConfig.enabled_entities,
    rollout_status: summary.enabled_blocked === 0 ? "safe" : "unsafe",
    overall_status: summary.blocked === 0 ? "ready" : "blocked",
    summary,
    entities,
  };
}

export async function buildPgReadReadinessReport(): Promise<PgReadReadinessReport> {
  const report = await buildPgOnlyRetentionReport();
  return buildPgReadReadinessReportFromRetentionReport(report);
}

export function renderPgReadReadinessReportText(report: PgReadReadinessReport): string {
  const lines = [
    "=== Konoha PG_READ readiness report ===",
    `Generated: ${report.generated_at}`,
    `Legacy PG_READ enabled: ${report.legacy_pg_read_enabled}`,
    `Enabled entities: ${report.enabled_entities.length ? report.enabled_entities.join(",") : "(none)"}`,
    `Rollout: ${report.rollout_status}`,
    `Overall: ${report.overall_status}`,
    `Summary: ready=${report.summary.ready} blocked=${report.summary.blocked} pg_primary=${report.summary.pg_primary} enabled=${report.summary.enabled} enabled_blocked=${report.summary.enabled_blocked}`,
    "",
  ];

  for (const entity of report.entities) {
    lines.push(`[${entity.status.toUpperCase()}] ${entity.entity}: pg_read_enabled=${entity.pg_read_enabled} redis=${entity.evidence.redis_count} pg=${entity.evidence.pg_count} onlyInRedis=${entity.evidence.only_in_redis_count} onlyInPg=${entity.evidence.only_in_pg_count}`);
    for (const blocker of entity.blockers) {
      lines.push(`  BLOCKER ${blocker.code}: count=${blocker.count} ${blocker.message}`);
      if (blocker.sample_ids?.length) lines.push(`    samples=${blocker.sample_ids.join(", ")}`);
    }
    if (entity.retention_groups.length > 0) {
      const top = entity.retention_groups[0]!;
      lines.push(`  top_retention_class=${top.retention_class} disposition=${top.disposition} candidate=${top.candidate} count=${top.would_delete_count}`);
    }
    lines.push(`  recommendation=${entity.recommendation}`);
  }

  return lines.join("\n");
}
