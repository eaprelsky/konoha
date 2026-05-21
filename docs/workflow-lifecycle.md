# Workflow Lifecycle And Deploy Gate

Issue #673 makes workflow execution explicit. Saving a process definition is no
longer the same operation as deploying it for runtime execution.

## States

| State | Meaning | Runnable by `case.start` |
| --- | --- | --- |
| `draft` | Editable definition. It may be incomplete or invalid. | no |
| `validated` | eEPC validation passed, but runtime triggers/subscriptions are not materialized. | no |
| `deployed` | Runtime deployment has materialized side effects, but readiness is not complete. Reserved for follow-up readiness slices. | no |
| `executable` | Deployment and readiness checks passed. New cases may start. | yes |
| `retired` | Hidden from new case starts. Existing cases follow the explicit migration/closure policy. | no |

## Write Path

- `workflow.create` with `draft=true` stores `draft` and records skipped validation metadata.
- `workflow.create` without `draft=true` validates and stores `validated`.
- `workflow.update` stores `draft` or `validated` and clears old deploy metadata; editing an executable workflow requires a new deploy before it can start new cases.
- `workflow.validate` returns the canonical readiness receipt used by deploy and
  start gates: `errors[]`, `warnings[]`, `readiness`, stable issue `code`
  values, and gate flags for deployment, case start, release, and reviewer
  review.
- `workflow.deploy` validates the current definition, resolves runtime start triggers, materializes start-event subscriptions, increments `deploy_version`, records `deployed_at` and optional `deployed_by`, and marks the workflow `executable` when readiness passes.
- `workflow.delete` is an archive/retire operation. It removes the workflow
  from active lists but keeps the Redis and PostgreSQL record with
  `lifecycle_state: "retired"` so old references and audit reads remain
  inspectable.
- Messenger-driven start triggers must include an activation policy covering
  deduplication, throttling/backpressure, and inspectable suppressions; invalid
  or missing policies block validation/deploy readiness.

Workflow records persist:

- `lifecycle_state`
- `status` as the canonical state for backward-compatible filtering/display
- `lifecycle` object with `schema_version: 1`, canonical state/status,
  `validation_status`, `deploy_version`, deploy/retire timestamps, actor fields,
  and migration provenance when backfilled from legacy records
- top-level compatibility fields: `validation_status`, `deploy_version`,
  `deployed_at`, `deployed_by`, `retired_at`, `retired_by`
- `last_validation`
- `last_deploy`
- `needs_review` when deploy is blocked by trigger review

## Migration And Compatibility

Legacy Redis/PG workflow records are normalized on read:

- `status: "active"` becomes `status/lifecycle_state: "executable"`;
- `status: "needs_review"` becomes `validated`;
- `status: "archived"` or `"deleted"` becomes `retired`;
- missing lifecycle metadata is backfilled into `lifecycle` with
  `migrated_from_status` and `backfilled_at`.

PostgreSQL shadow schema includes explicit lifecycle columns and repeatable
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` backfill statements in
`src/storage/schema.sql`. Runtime shadow writes also ensure the lifecycle
columns exist before writing, so older staging/prod databases can be migrated
without blocking Redis-primary operation.

Rollback follows `docs/workflow-runtime-rollback-recovery.md`: restore a
workflow snapshot or set a retired workflow back to `validated`, then redeploy
through `workflow.deploy`. Do not bypass the #812 terminal-case rule; terminal
cases must not receive new work, waits, subscriptions, or connector effects.

## Start Gate

`case.start` rejects every workflow whose `lifecycle_state` is not
`executable`. The gate is enforced at the runtime case-creation boundary, so
direct `createCase()`, `POST /cases`, `POST /trigger/:process_id`, action
envelopes, and event/subscription auto-start paths share the same contract.
Executable workflows are rechecked with the same readiness contract before a
case is created, so runtime drift such as a now-empty non-manual role blocks
new starts instead of silently creating work that cannot be handled. The
lifecycle rejection is structured:

```json
{
  "error": "Workflow is not executable",
  "code": "WORKFLOW_NOT_EXECUTABLE",
  "process_id": "sales/lead-qualification",
  "lifecycle_state": "validated",
  "required_lifecycle_state": "executable",
  "admin_override_available": true
}
```

Tests and migrations may pass `admin_override=true` explicitly. Product and
assistant paths should use `workflow.deploy` instead.

Readiness failures use `code: "WORKFLOW_READINESS_BLOCKED"` and include the
full validation receipt. `workflow.deploy` uses `code:
"WORKFLOW_VALIDATION_BLOCKED"` for the same blocking receipt.

## Operator Contract

The process editor shows the current lifecycle state. A saved draft or validated
workflow is not presented as executable; the operator must run Deploy before
starting new cases.

Authorization, confirmation, audit, token handling, and admin recovery controls
for workflow construction and runtime operations are defined in
`docs/workflow-security-boundary.md`.
