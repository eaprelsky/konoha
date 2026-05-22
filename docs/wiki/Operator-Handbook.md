# Operator Handbook

This page summarizes public operator workflows. Detailed production runbooks
remain in reviewed repository docs.

## Monitoring

Operators monitor:

- running cases and waiting states;
- pending, failed, or dead-letter runtime effects;
- work items and dispatch receipts;
- service health and resource pressure;
- PostgreSQL shadow consistency.

## Preflight

Use the portable preflight for local or CI-safe checks:

```bash
scripts/preflight-portable.sh
```

Production release checks are stricter and belong in an approved release
session:

```bash
scripts/preflight.sh
python3 scripts/pre-release-gate.py
```

## Release Gate

Workflow Engine release signoff is governed by
`docs/workflow-engine-release-gate.md` in the repository. The public rule is:
do not claim release readiness if validation, golden path, Action Spine
security, storage consistency, healthcheck, rollback evidence, or reviewer
acceptance is missing.

## Rollback And Recovery

Code rollback uses Git revert. Runtime recovery is separate because cases, work
items, subscriptions, reminders, outbox effects, streams, and external messages
are durable side effects. Recovery must use reviewed Action Spine or admin
contracts and preserve audit evidence.

## Blockers vs Warnings

Examples of blockers:

- failed required preflight;
- `pg-verify` reports Redis-only runtime records;
- required service health fails;
- a workflow can route new work to terminal cases;
- missing reviewer or owner approval for production release.

Examples of warnings:

- PostgreSQL-only retention bloat when Redis has no missing shadow rows;
- optional services disabled by profile as intended;
- known infrastructure warnings recorded in the release note.
