# Konoha Data-Store Backup And Restore Drill

Issue #787 defines the production-readiness gate for Konoha data stores. The
machine-readable source of truth is `docs/data-store-drill.json`; the automated
checker and report generator is `scripts/data-store-drill.ts`.

## RPO/RTO

| Target | Value |
| --- | --- |
| Global RPO | 60 minutes |
| Global RTO | 120 minutes |
| Drill target | `staging-core` |
| Production restore | Requires platform owner approval |

Owners:

- Primary: `platform_owner`
- Secondary: `sdd_team_lead`
- Reviewer: `shikadai`
- Escalation: `naruto`

## Covered Data Stores

| Store | Backup artifact | Restore target | Verification |
| --- | --- | --- | --- |
| PostgreSQL | `postgres.dump` from `pg_dump --format=custom` | staging Postgres | `scripts/pg-verify.ts`, shared config validation |
| Redis | `redis.rdb` from `redis-cli --rdb` | staging Redis | `redis-cli PING`, workflow keys, bus stream info |
| Workflow runtime | Redis workflow key inventory plus PG shadow verification | staging runtime | `scripts/pg-verify.ts`, workflow/retention tests |
| Operational config | encrypted `operational-config.tar` | staging filesystem | shared config validator, MCP secret scan |

Secret-bearing artifacts must be encrypted and retained for at least seven days.
Do not restore into production during a drill.

## Staging Restore Drill

1. Create encrypted PostgreSQL, Redis, workflow runtime, and operational config artifacts.
2. Restore artifacts into `staging-core`.
3. Run schema and Redis/Postgres shadow verification.
4. Run workflow smoke checks and retention cleanup dry-run.
5. Validate shared config and secret inventory without printing secret values.
6. Record RPO/RTO evidence and attach `konoha-data-store-drill-report.json` to the release gate.

## Commands

Validate the contract:

```bash
bun run scripts/data-store-drill.ts --check
```

Generate a drill report from observations:

```bash
bun run scripts/data-store-drill.ts \
  --observations /tmp/data-store-drill-observations.json \
  --report /tmp/konoha-data-store-drill-report.json
```

Portable preflight uses the committed passing fixture. For a real staging drill,
override the observation path:

```bash
DATA_STORE_DRILL_OBSERVATIONS=/tmp/data-store-drill-observations.json \
DATA_STORE_DRILL_REPORT=/tmp/konoha-data-store-drill-report.json \
scripts/preflight.sh
```
