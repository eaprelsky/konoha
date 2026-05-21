# Assistant Observable Results And Receipts

Issue: `#533`

Canonical server-side types live in `src/workflow-action-contract.ts`. Frontend API consumers use the matching `AssistantWorkflowResponse` and workflow receipt types in `frontend/src/api/types.ts`.

## Purpose

Every assistant turn that attempts to act must produce a canonical observable result surface:

- what was attempted
- what changed
- what failed
- what remains pending

This prevents Tsunade from acting as a black box and gives both the user and the platform a stable post-action contract.

## Canonical model

Assistant responses now expose:

- `edit_result` — explicit schema patch mode: `preview`, `pending_confirmation`, `committed`, or `failed`
- `action_receipts[]` — per-action receipts
- `observable_result` — aggregate result summary for the whole turn
- `pending_confirmations[]` — explicit outstanding confirmations

## Receipt fields

Each receipt includes:

- `action` — canonical action id such as `workflow.create` or `workflow.patch`
- `status` — `succeeded`, `pending_confirmation`, `failed`, or `partial`
- `summary` — user-visible summary
- `changed_resources[]` — concrete workflow/element/flow resources affected
- `audit` — audit linkage via `session_id` and `action_type`

## Current coverage

- Targeted `schema_patch` commits now route through the server-side `workflow.patch` Action Spine boundary and yield a success receipt only after durable persistence succeeds
- Untargeted/client-only `schema_patch` is marked `edit_result.mode=preview` and yields no durable success receipt
- Confirmation-required commits are marked `edit_result.mode=pending_confirmation`
- Durable commits are marked `edit_result.mode=committed`
- Readiness, validation, or malformed-patch failures are marked `edit_result.mode=failed` and must not be treated as saved canvas state
- Frontend canvas handling treats `edit_result.mode=preview` as local-only, `pending_confirmation`/`failed` as no-apply, and `committed` as an optimistic paint followed by a fresh backend workflow reload; the saved backend workflow is the source of truth after `workflow.patch`
- Concurrent durable edits use `expected_edit_version`/`expected_deploy_version` guards. A stale guard returns a 409 conflict (`WORKFLOW_PATCH_CONFLICT`, `WORKFLOW_UPDATE_CONFLICT`, or `WORKFLOW_MUTATION_CONFLICT`) and remains `edit_result.mode=failed`, with no workflow mutation.
- `create_workflow` yields a `workflow.create` receipt
- confirm-required workflow creation yields `pending_confirmation` receipts and aggregate result status instead of magical silence

## Aggregate result

`observable_result` is the canonical post-turn status envelope:

- `status`: `succeeded`, `pending_confirmation`, `failed`, `partial`, or `no_effect`
- `summary`: compact user-visible result summary
- `receipts`: the underlying receipts
- `counts`: status counts across receipts

This surface is intended to back both UI summaries and future operator evals.
