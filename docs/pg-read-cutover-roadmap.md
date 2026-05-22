# PG_READ Persistence Cutover Roadmap

Date: 2026-04-30

This document defines the phased plan for migrating read paths from Redis to PostgreSQL, using the `PG_READ=true` feature flag.

## Current State

- **Redis is primary**: All reads and writes go through Redis.
- **PG is shadow**: Writes are dual-written via `pgWrite()` wrapper; failures are silently caught.
- **PG_READ flag exists**: Individual read paths check `PG_READ=true` to switch to PG.
- **pg-verify.ts**: Compares Redis ↔ PG for 8 entities; reports `onlyInRedis` (data loss risk) and `onlyInPG` (historical retention / bloat).
- **Current production finding (2026-04-30)**: after `main@9739ac5`, `onlyInRedis=0`, but `pg-verify.ts` exits `2` because PG historical rows exceed the default bloat threshold. This is retention debt, not a deploy regression.

## Phased Rollout

### Phase 1: Verification (current → 2026-05-15)

**Goal**: Zero onlyInRedis records in production. PG shadow is consistently complete.

- [x] `pg-verify.ts` with `--strict` mode
- [ ] `pg-verify.ts` passes non-strict sync with `onlyInRedis=0` for 7 consecutive days
- [ ] Fix all onlyInRedis discrepancies through `--fix` or manual sync
- [x] Add pg-verify to preflight gate (#588)
- [x] Add a dry-run PG-only retention report before strict mode is required (`bun run scripts/pg-only-retention-report.ts`)
- [x] Define PG-only retention classes and safe cleanup candidate policy from dry-run reports (#738)
- [ ] Decide whether non-strict bloat should be warning-only or a release blocker

**Exit criteria**: non-strict `bun run scripts/pg-verify.ts` has zero `onlyInRedis` daily for one week, and PG-only retention policy is documented. `--strict` remains a later hardening target after retention cleanup exists.

### Phase 2: Read-path profiling (2026-05-15 → 2026-06-01)

**Goal**: Measure PG read performance against Redis baseline. No traffic shift.

- [ ] Add latency instrumentation to all `PG_READ` code paths
- [ ] Run read-only workload against PG mirror in staging
- [ ] Document performance delta per entity:
  - agents: expected <2ms for both (single-row PK lookup)
  - workflows: PG may be slower (JSONB deserialization vs raw Redis GET)
  - cases/work_items: PG may be faster for filtered list queries
  - messages: PG may be faster for timestamp-sorted pagination

**Exit criteria**: Performance baseline documented. No query >50ms at p99.

### Phase 3: Gradual traffic shift (2026-06-01 → 2026-06-30)

**Goal**: Shift read traffic incrementally, one entity at a time.

1. **Week 1**: `PG_READ=true` for agents, roles, documents (static/low-volume)
2. **Week 2**: + workflows (cached reads, moderate volume)
3. **Week 3**: + cases, work_items (high volume, filtered queries)
4. **Week 4**: + messages, reminders, audit (streaming/pagination)

Each shift:
- Deploy flag for specific entity subset
- Monitor pg-verify for 24h.
- Roll back if `onlyInRedis` appears or latency spikes.
- Treat `onlyInPG` bloat as a retention signal until cleanup policy is implemented; do not enable `PG_READ=true` for entities whose historical rows are not filtered.

**Exit criteria**: All read paths on PG with zero regressions.

### Phase 4: Write-path switch (2026-07-01 → 2026-07-31)

**Goal**: PG becomes primary for writes. Redis becomes cache layer.

- [ ] Implement PG-write-primary with Redis cache-invalidation
- [ ] Dual-run for 2 weeks (write to both, verify consistency)
- [ ] Switch primary writes to PG, Redis as read-through cache
- [ ] Decommission Redis-only write paths

**Exit criteria**: PG is primary for all CRUD. Redis is cache-only.

### Phase 5: Redis decommissioning (2026-08-01+)

**Goal**: Redis is optional. System runs on PG alone.

- [ ] Remove Redis dependency from core paths
- [ ] Redis becomes a configurable cache layer (like Memcached)
- [ ] All message streaming moves to PG LISTEN/NOTIFY or alternative

**Exit criteria**: System boots and operates correctly with Redis disconnected.

## Rollback Procedures

At any phase, rollback is:
1. Set `PG_READ=false`
2. Restart server
3. All reads return to Redis

No data migration is needed for rollback because Redis remains the write-primary through Phase 3.

## Guardrails

- `pg-verify.ts` runs in production preflight. `onlyInRedis` blocks deployment. `onlyInPG` bloat currently exits non-zero in the script, but operationally requires a retention decision rather than Redis -> PG migration.
- `pg-only-retention-report.ts` is the read-only next step for PG-only rows. It groups would-delete candidates by entity/status/process prefix/id prefix/age bucket and keeps `onlyInRedis` as a hard failure.
- PG connection pool monitored; max 20 connections
- All `pgWrite()` failures logged to `konoha:events:pg-errors` stream
- Weekly audit of PG/Redis consistency during transition
