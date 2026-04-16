# Assistant Observable Results And Receipts

Issue: `#533`

## Purpose

Every assistant turn that attempts to act must produce a canonical observable result surface:

- what was attempted
- what changed
- what failed
- what remains pending

This prevents Tsunade from acting as a black box and gives both the user and the platform a stable post-action contract.

## Canonical model

Assistant responses now expose:

- `action_receipts[]` — per-action receipts
- `observable_result` — aggregate result summary for the whole turn
- `pending_confirmations[]` — explicit outstanding confirmations

## Receipt fields

Each receipt includes:

- `action` — canonical action id such as `workflow.create` or `workflow.update`
- `status` — `succeeded`, `pending_confirmation`, `failed`, or `partial`
- `summary` — user-visible summary
- `changed_resources[]` — concrete workflow/element/flow resources affected
- `audit` — audit linkage via `session_id` and `action_type`

## Current coverage

- `schema_patch` now yields a `workflow.update` receipt plus audit event
- `create_workflow` yields a `workflow.create` receipt
- confirm-required workflow creation yields `pending_confirmation` receipts and aggregate result status instead of magical silence

## Aggregate result

`observable_result` is the canonical post-turn status envelope:

- `status`: `succeeded`, `pending_confirmation`, `failed`, `partial`, or `no_effect`
- `summary`: compact user-visible result summary
- `receipts`: the underlying receipts
- `counts`: status counts across receipts

This surface is intended to back both UI summaries and future operator evals.
