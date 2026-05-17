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

`retention.cleanup_preview` is also read-only. It returns exact IDs only for rows classified as `safe_candidate:*`, omits review-only rows, and blocks candidate output when Redis-only mismatches exist. It is a preview contract for future cleanup, not a delete operation.

`retention.cleanup_apply` is the destructive Action Spine entry point. It is deliberately narrow:

- requires admin confirmation through `/act`;
- requires `confirm: true`;
- accepts only exact `{ entity, id, candidate }` tuples from preview;
- re-runs the PG-only report before deleting;
- deletes only rows that are still absent from Redis and still classify as `safe_candidate:*`;
- blocks the whole batch if any requested candidate is invalid, stale, duplicated, mismatched, or if Redis-only rows exist;
- deletes from Postgres shadow/historical tables only.

`retention.runtime_cleanup` is the automatic Redis-primary cleanup surface for live runtime bloat. It is narrower than operator-driven workflow deletion:

- defaults to dry-run for direct Action Spine calls;
- Tsunade runs it periodically with `dry_run=false`;
- deletes only generated/test/debug runtime cases or cases that explicitly opt in with `payload.retention.auto_delete=true` or `payload.__retention.auto_delete=true`;
- deletes terminal workflow runs only after all related work items are `done`, `cancelled`, or `error`;
- deletes stuck running cases only after `KONOHA_STUCK_CASE_TTL_HOURS` and only when no active work item is assigned to an online agent;
- removes Redis case/work item keys and indexes, cancels event waits/subscriptions, and best-effort deletes the Postgres shadow rows.

Runtime cleanup defaults:

- `KONOHA_STUCK_CASE_TTL_HOURS=24`
- `KONOHA_COMPLETED_WORKFLOW_TTL_HOURS=24`
- `KONOHA_RUNTIME_RETENTION_MAX_DELETE=100`
- `KONOHA_RUNTIME_RETENTION_INTERVAL_MS=3600000`

The script remains available for operations:

```bash
PATH=/home/ubuntu/.bun/bin:$PATH bun run scripts/pg-only-retention-report.ts --limit=20
PATH=/home/ubuntu/.bun/bin:$PATH bun run scripts/pg-only-retention-report.ts --json
```

## Workflow

`workflows/reliability/retention-cleanup.json` is the canonical eEPC wrapper around retention operations:

1. A scheduled timer event starts the retention audit.
2. `retention.report` generates a read-only summary.
3. `retention.cleanup_preview` returns exact safe-candidate tuples.
4. A `platform_owner` reviews and approves or rejects the batch.
5. `retention.cleanup_apply` runs only after approval and only with exact preview tuples.
6. A summary function records the outcome for operations.

This keeps lifecycle policy visible in the workflow engine instead of hiding it in scripts or UI filters.

## Policy

Safe cleanup must be implemented in stages:

1. Report only: identify candidate groups without writing data.
2. Preview: return exact IDs that would be deleted, still without writing data.
3. Apply: require admin confirmation, audit trail, and backup/rollback assumptions.
4. Scheduled workflow: retention audit event -> report -> preview -> human approval -> cleanup -> summary event.

Default cleanup rules must not delete business artifacts. Only generated/test/debug artifacts or orphaned artifacts from archived/deleted workflows can become default cleanup candidates.

Runtime auto-cleanup follows the same rule: production-looking workflows are retained by default even when their cases are terminal or stuck. They need an explicit per-case auto-delete opt-in before Tsunade can remove them.

## Non-Goals

- PG-only destructive cleanup is limited to exact `safe_candidate:*` rows via `retention.cleanup_apply`.
- UI hidden-artifact filtering remains independent from retention.
- Sales/business workflow runs are retained unless an operator chooses a narrower future policy.
