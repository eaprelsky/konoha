# Redis/PostgreSQL Consistency Parent Closure Report

Issue #683 is the parent umbrella for Redis/PostgreSQL consistency and the
retention gate before PG_READ rollout. The machine-readable closure receipt is
`docs/pg-read-consistency-closure-report.json`.

## Closure Invariant

Redis remains primary for workflow/runtime entities until each PG_READ entity is
explicitly enabled after readiness evidence. `onlyInRedis` is a cutover blocker.
`onlyInPG` rows must be classified by retention policy before cleanup or PG_READ
rollout.

## Covered Surfaces

| Surface | Contract |
| --- | --- |
| Agent SOT split | Konoha bus agent presence is PostgreSQL-primary; managed agent definitions and AGENTS.md lifecycle remain Redis/managed-definition projections. |
| PG-only retention | `pg-only-retention-report.ts` is read-only, groups PG-only rows by retention class/disposition, and refuses cleanup planning while Redis-only rows exist. |
| PG_READ readiness | `pg-read-readiness-report.ts`, API, and Action Spine report `ready`, `blocked`, or `pg_primary` per entity with stable blocker codes. |
| Entity flags | `PG_READ_ENTITIES` and per-entity `PG_READ_*` flags are default-off and preferred over the legacy global `PG_READ=true`. |
| Runtime retention | High-volume runtime retention keeps active artifacts visible and blocks archive/compaction when active waits/effects or Redis-only rows remain. |

## Child Evidence

Closed detailed slices: #737, #738, #739, #740, and #754.

Those slices cover the original #683 acceptance criteria for pg-verify SOT
correctness, PG-only retention classification, PG_READ readiness reporting,
staged PG_READ flags, and runtime retention safety gates.

## Review Commands

```bash
PATH=/home/ubuntu/.bun/bin:$PATH bun test --timeout 30000 \
  tests/pg-read-consistency-closure-report.test.ts \
  tests/pg-verify-agent-contract.test.ts \
  tests/pg-only-retention-report.test.ts \
  tests/pg-read-readiness-report.test.ts \
  tests/pg-read-flags.test.ts \
  tests/runtime-retention-policy.test.ts \
  tests/runtime-retention-cleanup.test.ts

PATH=/home/ubuntu/.bun/bin:$PATH bun run scripts/action-surface-report.ts --check
python3 scripts/check-route-auth-policy.py
PATH=/home/ubuntu/.bun/bin:$PATH bun run typecheck
```

## Closure Recommendation

#683 can close after Shikadai review as the Redis/PostgreSQL consistency and
PG_READ retention-gate umbrella. This does not claim production release or
blanket PG_READ readiness: live rollout remains entity-scoped, default-off, and
blocked by any `onlyInRedis` evidence.
