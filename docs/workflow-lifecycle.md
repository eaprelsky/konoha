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
- `workflow.deploy` validates the current definition, resolves runtime start triggers, materializes start-event subscriptions, records deploy metadata, and marks the workflow `executable` when readiness passes.
- Messenger-driven start triggers must include an activation policy covering
  deduplication, throttling/backpressure, and inspectable suppressions; invalid
  or missing policies block validation/deploy readiness.

Workflow records persist:

- `lifecycle_state`
- `status` for backward-compatible filtering/display
- `last_validation`
- `last_deploy`
- `needs_review` when deploy is blocked by trigger review

## Start Gate

`case.start` rejects every workflow whose `lifecycle_state` is not
`executable`. The rejection is structured:

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

## Operator Contract

The process editor shows the current lifecycle state. A saved draft or validated
workflow is not presented as executable; the operator must run Deploy before
starting new cases.

Authorization, confirmation, audit, token handling, and admin recovery controls
for workflow construction and runtime operations are defined in
`docs/workflow-security-boundary.md`.
