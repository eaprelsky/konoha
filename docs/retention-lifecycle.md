# Runtime Data Retention Lifecycle

Operator UI filters are presentation rules only. They must not be treated as a data lifecycle strategy.

Konoha stores active runtime data in Redis and shadows operational history into Postgres. A healthy migration state has no Redis-only rows. Postgres-only rows can still be expected historical/shadow data, but they need explicit retention policy so test/demo artifacts do not grow without bound.

## Current Safe Surface

`retention.report` is the canonical read-only Action Spine entry point for retention visibility. It runs the same PG-only grouping logic as `scripts/pg-only-retention-report.ts` and returns:

- per-entity Redis and Postgres counts;
- Redis-only hard-fail indicators;
- PG-only candidate groups;
- sample IDs for operator review;
- `mode: "dry_run"` to make the non-destructive behavior explicit.

The script remains available for operations:

```bash
PATH=/home/ubuntu/.bun/bin:$PATH bun run scripts/pg-only-retention-report.ts --limit=20
PATH=/home/ubuntu/.bun/bin:$PATH bun run scripts/pg-only-retention-report.ts --json
```

## Policy

Safe cleanup must be implemented in stages:

1. Report only: identify candidate groups without writing data.
2. Preview: return exact IDs that would be deleted, still without writing data.
3. Apply: require admin confirmation, audit trail, and backup/rollback assumptions.
4. Scheduled workflow: retention audit event -> report -> human approval -> cleanup -> health event.

Default cleanup rules must not delete business artifacts. Only generated/test/debug artifacts or orphaned artifacts from archived/deleted workflows can become default cleanup candidates.

## Non-Goals

- No destructive cleanup is implemented by `retention.report`.
- UI hidden-artifact filtering remains independent from retention.
- Sales/business workflow runs are retained unless an operator chooses a narrower future policy.
