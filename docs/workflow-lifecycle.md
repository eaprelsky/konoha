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
- `workflow.patch` is the durable server-side constructor edit boundary for
  schema patches. It applies element, flow, trigger, name, and description
  mutations through the same atomic workflow CAS boundary, validates the full
  resulting workflow, and either persists the complete patch or rejects it
  without partial writes. Patching an executable workflow demotes the editable
  definition to `validated`; deployed runtime snapshots already bound to
  running cases are not changed.
- `GET /workflows/:id/validation?source=workflow.deploy` exposes the same
  canonical receipt for browser diagnostics and operator tooling. Clients must
  consume the structured receipt fields instead of parsing human messages.
- Validation/readiness receipts include `taxonomy_version: 1`. Each issue has
  machine-readable `code`, `class`, `severity`, `message`, and optional
  `legacy_code`, `element_id`, `edge`, and `details`. Product logic must use
  `code`/`class`; `message` is display text only. The canonical classes are
  `graph`, `role`, `trigger`, `adapter`, `document`, `deployment`,
  `migration`, and `lifecycle`.
  Graph validation blocks malformed edge tuples, duplicate element ids,
  unreachable elements, non-event terminal states, reachable nodes without a
  terminal path, ambiguous unconditioned terminal branches, and pass-through
  cycles with no function boundary. Rework cycles remain valid when they pass
  through a function work boundary and retain a path to a terminal event.
- Gateway conditions use a bounded payload DSL, not arbitrary JavaScript:
  `payload.<field>` references, string/number/boolean/null/undefined literals,
  `===`, `!==`, `==`, `!=`, numeric comparisons, `!`, `&&`, `||`, and
  parentheses. Unsupported tokens, function calls, assignments, and malformed
  expressions block readiness with stable graph codes. When a workflow declares
  `payload_fields`, `payload_schema`, or function `output_fields`/`output_schema`,
  readiness also blocks conditions that reference unknown payload fields. XOR
  gateways with multiple outgoing conditional branches emit
  `GRAPH_GATEWAY_MISSING_DEFAULT` until one unconditioned default branch is
  present, so reviewers can see when runtime routing will error if no condition
  matches.
- `workflow.deploy` validates the current definition, resolves runtime start
  triggers, increments `deploy_version`, records `deployed_at` and optional
  `deployed_by`, marks the workflow `executable`, saves the deployed snapshot,
  and only then materializes start-event subscriptions.
- `workflow.deploy` also stores an immutable deployed runtime snapshot keyed by
  workflow id and deploy version. `case.start` binds each new case to that
  snapshot in `workflow_snapshot`, and runtime advancement loads the bound
  snapshot for work items, event confirmations, event waits, and subprocess
  returns. Draft edits, validation-only updates, retirement, or later redeploys
  therefore do not mutate cases that are already running. A later redeploy
  affects only cases started after that deploy version. Legacy cases without a
  binding fall back to the current workflow definition until an explicit
  migration policy exists.
- `workflow.retire` is the canonical retire operation. It removes the workflow
  from active lists, marks `lifecycle_state: "retired"`, records optional
  `retired_by`, and can run in `retire_only`,
  `archive_with_runtime_cleanup`, or `purge_generated` mode.
- `workflow.delete` is a compatibility archive route for `workflow.retire`
  with the same durable retired record and default runtime cleanup.
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
Lifecycle gate failures keep their outer action/API codes, such as
`WORKFLOW_NOT_EXECUTABLE` or `WORKFLOW_RETIRED`, and also include a
`validation_issue` with taxonomy class `lifecycle` (`LIFECYCLE_NOT_EXECUTABLE`
or `LIFECYCLE_RETIRED`).

## Deploy And Retire Action Results

`workflow.deploy` returns the updated workflow definition on success. The
response includes `deployment`, whose `transaction` field is the canonical
deployment transaction receipt:

```json
{
  "transaction_id": "sales/lead-qualification:v3:transaction",
  "idempotency_key": "workflow.deploy:sales/lead-qualification:v3",
  "workflow_id": "sales/lead-qualification",
  "deploy_version": 3,
  "deployment_id": "sales/lead-qualification:v3",
  "status": "completed",
  "commit_order": [
    "validate",
    "commit_executable_workflow",
    "save_deployed_snapshot",
    "materialize_subscription_diff",
    "persist_deploy_receipt"
  ],
  "records": {
    "workflow": "workflow:sales/lead-qualification",
    "deployed_snapshot": "workflow:deployed:sales/lead-qualification:v3",
    "deploy_receipt": "workflow.last_deploy.side_effects"
  },
  "retry_policy": {
    "scope": "workflow_deploy_version",
    "operation_key_template": "{workflow_id}:v{deploy_version}:{event_id}",
    "duplicate_effect": "matching_active_subscription_is_unchanged"
  }
}
```

Callers may pass `idempotency_key`; otherwise the server derives
`workflow.deploy:<workflow_id>:v<deploy_version>`. Per-subscription receipts
also include deterministic `operation_key` and `idempotency_key` values for
created, cancelled, unchanged, failed, and rollback operations. The durable
deploy record is `workflow.last_deploy`; its `side_effects` field stores the
same transaction/subscription receipt after materialization.

Failures use stable `code` values:

- `WORKFLOW_NOT_FOUND` for unknown workflow ids, with `workflow_id`;
- `WORKFLOW_RETIRED` when a retired workflow is deployed again;
- `WORKFLOW_DEPLOY_NEEDS_REVIEW` when trigger resolution requires operator
  review, including the canonical `validation` receipt;
- `WORKFLOW_VALIDATION_BLOCKED` when readiness blocks deployment, including the
  canonical `validation` receipt.
- `WORKFLOW_DEPLOY_SNAPSHOT_FAILED` when the deployed snapshot cannot be saved;
  no subscription side effects have started.
- `WORKFLOW_DEPLOY_SIDE_EFFECT_FAILED` when subscription materialization fails;
  the response includes rollback evidence and the workflow is demoted back to
  `validated` with `needs_review`.

`workflow.retire` returns a stable receipt:

```json
{
  "ok": true,
  "workflow_id": "sales/lead-qualification",
  "action": "workflow.retire",
  "mode": "archive_with_runtime_cleanup",
  "retired": true,
  "lifecycle_state": "retired",
  "retired_by": "operator-1",
  "already_retired": false,
  "archived": true,
  "deleted_cases": 0,
  "deleted_work_items": 0,
  "cancelled_subscriptions": 0
}
```

Unknown workflow ids use `WORKFLOW_NOT_FOUND`. Invalid cleanup modes use
`WORKFLOW_RETIRE_INVALID_MODE` and include `allowed_modes`. Repeated retire
calls are idempotent and return `already_retired: true` without changing the
existing retire actor metadata.

## Operator Contract

The process editor shows the current lifecycle state. A saved draft or validated
workflow is not presented as executable; the operator must run Deploy before
starting new cases.
ProcessEditor, the process tree, and run controls use the backend
`lifecycle_state` contract directly. The Run control calls `case.start` only
for `lifecycle_state: "executable"` and does not expose `admin_override`; for
`draft`, `validated`, `deployed`, or `retired` workflows it stays disabled with
the same `WORKFLOW_NOT_EXECUTABLE` reason used by the backend gate.
ProcessEditor also refreshes the canonical validation receipt for the selected
workflow and renders diagnostics by stable `code`, `class`, target element or
edge, and gate flags. Deploy and Run controls use those gate flags so frontend
behavior matches the backend deploy and case-start contracts.

Authorization, confirmation, audit, token handling, and admin recovery controls
for workflow construction and runtime operations are defined in
`docs/workflow-security-boundary.md`.
