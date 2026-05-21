# Runtime Effect Outbox Data Model

Issue #715 defines the durable data model for workflow runtime side effects.
Issue #716 adds the worker/storage contract that drains this outbox with
bounded retry, dead-letter, idempotency, and lock semantics. This page is the
contract those workers and callers must preserve.

## Record Contract

Runtime effects are represented by `RuntimeEffectRecord` in
`src/runtime-effect-outbox.ts`.

Required fields:

| Field | Meaning |
|---|---|
| `schema_version` | Current value is `1`. |
| `effect_id` | Deterministic id derived from `idempotency_key`. |
| `kind` | Stable effect kind such as `connector.send_message`, `workitem.dispatch`, `subscription.create`, `subscription.cancel`, or `deploy.subscription.rollback`. |
| `payload` | Effect-specific object payload. |
| `idempotency_key` | Source-stable key that suppresses duplicate effects. |
| `status` | One of `pending`, `in_flight`, `succeeded`, `failed`, `retry`, `dead_letter`, `cancelled`. |
| `attempts` | Dispatch attempts made by workers. |
| `retry_policy` | Max attempts, backoff type, retry delays, and dead-letter threshold. |
| `links` | Correlation fields for workflow/case/work item/subscription/deploy/action traces. |
| `created_at`, `updated_at` | ISO timestamps. |

Optional fields:

| Field | Meaning |
|---|---|
| `next_retry_at` | Required while `status=retry`. |
| `locked_by`, `locked_until` | Worker claim metadata while `status=in_flight`. |
| `completed_at` | Terminal timestamp for `succeeded`, `dead_letter`, or `cancelled`. |
| `error` | Machine-readable failure code/message/retryable flag. |
| `receipt` | Effect-specific success/failure/cancel receipt. |

Every record must carry at least one durable correlation link:
`case_id`, `work_item_id`, `deploy_record_key`, `subscription_id`, or
`action_trace_id`. Deploy-side effects should also include `workflow_id`,
`deploy_version`, and `deployment_id` when available.

## Redis Keyspace

The model reserves the following key/index names. Storage implementation can be
added behind these stable keys without changing the record shape:

| Key | Purpose |
|---|---|
| `runtime:effect:<effect_id>` | Canonical serialized `RuntimeEffectRecord`. |
| `runtime:effect:idempotency:<hash>` | Idempotency lookup from source key to effect id. |
| `runtime:effect:index:status:<status>` | Status queue/index for worker selection and operations. |
| `runtime:effect:index:case:<case_id>` | Case correlation index. |
| `runtime:effect:index:work-item:<work_item_id>` | Work-item correlation index. |
| `runtime:effect:index:deploy-record:<hash>` | Deploy record correlation index. |
| `runtime:effect:index:subscription:<subscription_id>` | Subscription correlation index. |
| `runtime:effect:lock:<effect_id>` | Short-lived worker claim lock. |

`enqueueRuntimeEffect()` writes the canonical record, idempotency lookup, status
index, and all correlation indexes. Re-enqueueing the same source
`idempotency_key` returns the existing record with `duplicate=true` and does not
overwrite the original payload.

## State Machine

Allowed transitions:

| From | To |
|---|---|
| `pending` | `in_flight`, `cancelled`, `dead_letter` |
| `in_flight` | `succeeded`, `failed`, `retry`, `dead_letter` |
| `failed` | `retry`, `dead_letter` |
| `retry` | `in_flight`, `cancelled`, `dead_letter` |
| `succeeded` | terminal |
| `dead_letter` | terminal |
| `cancelled` | terminal |

`in_flight` increments `attempts` and may set `locked_by`/`locked_until`.
`retry` requires `next_retry_at` and a machine-readable `error`. Terminal
statuses cannot move back to retry or in-flight.

`processRuntimeEffectOutboxOnce()` claims one due `pending` or `retry` record,
sets a short-lived lock, transitions it to `in_flight`, and runs the supplied
handler. Handler success transitions to `succeeded` with a receipt. Handler
failure transitions to `retry` when the error is retryable and the attempt
budget remains; otherwise it transitions to `dead_letter`. A `retry` record at
`dead_letter_after_attempts` cannot be claimed again and must be dead-lettered.

## Idempotency And Correlation

The idempotency key must be scoped by the source that creates the effect:

- deploy subscription effects use the existing deployment-scoped keys such as
  `workflow.deploy:<workflow_id>:v<deploy_version>:subscription:<operation>:<event_id>`;
- work-item dispatch effects should include `case_id` and `work_item_id`;
- connector effects should include connector/message identifiers before an
  external send is attempted;
- event publication effects should include the originating event or action
  trace key.

For deploy rollback and retry, `deploy_record_key` ties the effect back to the
durable deploy record introduced by #711 and the rollback evidence strengthened
by #714. If rollback cannot cancel a created subscription, the failed effect
must keep the active `subscription_id` correlation so a retry can reconcile or
reuse it without creating duplicates.

## Rollback And Recovery

Code rollback does not unsend external effects. Recovery must inspect outbox
records and receipts before manually replaying, cancelling, or dead-lettering an
effect. Running-case and intermediate subscription effects must use concrete
`case_id`/`work_item_id` links and must not be confused with deploy-managed
`instance_id="new"` start subscriptions.

For runtime recovery procedures, use
`docs/workflow-runtime-rollback-recovery.md`. For release gates, use
`docs/workflow-constructor-runtime-release-checklist.md`.
