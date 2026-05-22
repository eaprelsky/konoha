# Persistence Source-of-Truth Rules

Date: 2026-04-30

This document defines which store is canonical for each entity in the Konoha system. Workflow/runtime entities are Redis-primary today; Konoha bus presence is PostgreSQL-primary with a legacy Redis compatibility hash. The default migration direction for workflow data is Redis -> PG until `PG_READ=true` cutover criteria are met.

## Entity SOT Matrix

| Entity | Primary (SOT) | Shadow | Redis Key Pattern | PG Table | Sync Mechanism |
|--------|--------------|--------|-------------------|----------|----------------|
| agent presence | PG | Redis compatibility | `konoha:registry` (hash, legacy) | `konoha_agents` | `pgRegisterAgent()` / `pgHeartbeat()` on register/heartbeat; hard unregister also cleans legacy Redis |
| managed agent definitions | Redis | — | `konoha:agent-defs`, `konoha:agent-templates`, `konoha:agent-runtime-configs` | — | `src/agent-lifecycle.ts` split definition storage |
| workflows | Redis | PG | `konoha:workflow:*` (JSON) | `workflows` | `pgWrite()` wrapper on create/update/delete |
| cases | Redis | PG | `konoha:cases:*` (JSON) | `cases` | `pgWrite()` wrapper on save/advance |
| work_items | Redis | PG | `konoha:workitem:*` (JSON) | `work_items` | `pgWrite()` wrapper on create/complete |
| roles | Redis | PG | `konoha:roles:*` (hash) | `roles` | `pgWrite()` wrapper on CRUD |
| documents | Redis | PG | `konoha:docs:*` (hash) | `documents` | `pgWrite()` wrapper on CRUD |
| reminders | Redis | PG | `konoha:reminders:*` (hash) | `reminders` | `pgWrite()` wrapper on create/update |
| messages | Redis | PG | `konoha:agent:*` (stream) | `konoha_messages` | `pgStoreMessage()` on send |
| bus messages | Redis | PG | `konoha:bus` (stream) | `konoha_messages` | `pgStoreMessage()` on send |

## Operational Rules

1. **Workflow writes go to Redis first.** Redis is the system of record for active Workflow Engine data until the PG cutover.
2. **Bus presence writes go to PostgreSQL first.** `konoha:registry` exists only for legacy compatibility and verification.
3. **PG shadow for workflow data is async.** `pgWrite()` / `pgStoreMessage()` fire after Redis write succeeds. PG failures are logged but never block the Redis write path.
4. **PG_READ feature flag** (`PG_READ=true`) switches workflow reads to PG for gradual cutover testing. When enabled, read paths query PG tables instead of Redis keys.
5. **Verification** runs via `bun run scripts/pg-verify.ts`:
   - `onlyInRedis > 0` is a data-loss risk and blocks PG cutover work.
   - `onlyInPG` is historical/shadow retention by default, but the script currently exits `2` when it exceeds the configured bloat threshold.
   - `PG_BLOAT_THRESHOLD=<number>` changes the non-strict bloat threshold for diagnostics.
   - `--strict` treats any Redis/PG mismatch as a failure and is not expected to pass on production until retention policy is implemented.
   - Agent presence is the exception to the Redis-primary migration rule:
     `konoha_agents` is canonical and `konoha:registry` is legacy
     compatibility only, so PG-only presence rows are not managed-agent
     definition drift.
   - Managed agent definitions are verified separately through the Redis
     `konoha:agent-defs`, `konoha:agent-templates`, and
     `konoha:agent-runtime-configs` projections. AGENTS.md files are generated
     by the managed lifecycle from those definitions, not from bus presence.
6. **Retention reporting** runs via `bun run scripts/pg-only-retention-report.ts`:
   - read-only SELECTs only; it never deletes or updates production data.
   - groups PG-only rows by entity, candidate class, status, process/id prefix, age bucket, and `would_delete_count`.
   - exits non-zero if any `onlyInRedis` rows are present, because retention cleanup must not proceed while PG shadow is missing Redis-primary records.
   - text output shows the top groups by default; use `--limit=<n>`, `--all`, or `--json` when creating a follow-up cleanup issue from the report output.

## Recovery Procedures

### Redis → PG divergence (onlyInRedis)
Records exist in Redis but not in PG.
- **Risk**: data loss on Redis failure
- **Fix**: `bun run scripts/migrate-redis-to-pg.ts`

### PG → Redis divergence (onlyInPG)
Records exist in PG but not in Redis.
- **Risk**: stale data if `PG_READ=true` is enabled without retention filtering; otherwise mostly archived/historical rows.
- **Current production status (2026-04-30)**: `onlyInRedis=0`, but PG has historical bloat in cases, work items, workflows, and documents. This is not a `9739ac5` deploy regression.
- **Threshold**: non-strict `pg-verify.ts` exits `2` when `onlyInPG` exceeds 100% of `redisCount` unless `PG_BLOAT_THRESHOLD` is raised for diagnostics.
- **Fix**: define retention policy first. Do not run destructive cleanup from `pg-verify` output alone. `migrate-redis-to-pg.ts --dry-run` is useful for `onlyInRedis`, but it does not classify or remove `onlyInPG` rows.
- **Safe next step**: run `bun run scripts/pg-only-retention-report.ts` and review the safe-candidate groups before any delete mode exists. Initial safe-candidate classes include offline debug agents, generated draft/eval workflows, and old completed generated test cases/work items.

### Dual-write failures
If `pgWrite()` fails, the Redis write succeeded but PG is missing the record. The next `pg-verify.ts` run will catch it.
