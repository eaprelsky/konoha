# Workflow Security, Authorization, And Audit Boundary

Issue #789 defines the security boundary for AI-assisted workflow construction
and runtime operations. This document is the human-readable contract; the
machine-readable action matrix remains `docs/action-surface.json`, generated
from `src/action-registry.ts`.

## Scope

The boundary covers operations that can create or change workflow definitions,
materialize runtime triggers, start or mutate cases, retry or cancel runtime
effects, mutate role bindings, inspect workflow or event payloads, read audit
records, and recover from stuck runtime state.

All new user-visible workflow mutations must enter through the Action Spine
(`POST /act`) or a compatibility route that delegates to the same domain
executor. New routes must not create a parallel permission, confirmation, or
audit contract.

## Actor Boundary

| Actor | Meaning | Workflow security boundary |
| --- | --- | --- |
| Admin token | Server operator or trusted automation using `KONOHA_TOKEN` | May perform workflow construction, deploy/retire, runtime recovery, role binding, audit read, and payload inspection actions. |
| Agent token | Managed worker registered on the Konoha bus | May use only actions whose registry policy is `authenticated` or `agent_self`; workflow construction and runtime recovery stay admin-only. |
| Assistant | Product assistant acting on behalf of a user through `/act` or normalization | Inherits the canonical action autonomy level; confirm actions produce pending confirmations and no side effect before confirmation. |
| External operator token | Future scoped operator identity | Must map to explicit scopes before it can cross this boundary; it must not be treated as an admin token by default. |
| System runtime | Internal dispatcher, event manager, timers, and connectors | May advance already-authorized runtime state but must not edit definitions, deploy workflows, change role bindings, or bypass Action Spine recovery controls. |

## Permission Matrix

The current registry uses `security.actor` as the enforced authorization
boundary, `autonomy` as the assistant/operator confirmation boundary, and
`audited` as the audit-write boundary. `admin` below means the action is
rejected for regular agent tokens before execution.

| Operation | Canonical actions | Required actor | Autonomy | Audit |
| --- | --- | --- | --- | --- |
| Create or edit workflow definitions | `workflow.create`, `workflow.update`, `workflow.patch`, `element.add`, `element.update`, `element.remove`, `flow.add`, `flow.remove`, `trigger.set` | admin | confirm | required |
| Preview or validate workflow definitions | `workflow.list`, `workflow.get`, `trigger.resolve` | admin | auto | no audit for pure reads; `trigger.resolve` is audited because it may persist resolver output when wired |
| Deploy runtime triggers | `workflow.deploy` | admin | confirm | required |
| Retire or archive workflows | `workflow.retire`, `workflow.delete`, `workflow.batch_delete` | admin | confirm | required |
| Start workflow cases | `case.start` | admin | auto | required |
| Inspect case and event payloads | `case.get`, `case.list`, `event.wait_list` | admin | auto | no audit for current read-only inspection actions |
| Complete or mutate work items | `workitem.create`, `workitem.update`, `workitem.complete`, `workitem.cancel` | admin | auto | required |
| Retry, cancel, or recover runtime effects | `case.close`, `case.cancel`, `case.delete`, `event.confirm`, `retention.cleanup_apply`, `retention.runtime_cleanup` | admin | confirm for destructive case and retention actions; event confirmation is an explicit admin runtime action | required for all writes |
| Mutate role bindings | `role.create`, `role.update`, `role.delete` | admin | confirm | required |
| Read role bindings | `role.list` | admin | auto | no audit |
| Read action audit trail | `audit.read` | admin | auto | no recursive audit entry |
| Configure access lists or trusted users | `access.approve`, `access.reject`, `access.upsert_user`, `access.remove_user`, `access.add_group`, `access.remove_group` | admin | confirm or auto per registry | required for mutations |

If a new workflow operation does not fit this matrix, it must add or update a
registry action first and justify any non-admin actor policy in the issue or ADR.

## Audit Event Contract

All implemented mutating Action Spine actions must write to `konoha:audit`
unless the registry marks them planned or read-only. The audit record contract is:

| Field | Required | Notes |
| --- | --- | --- |
| `timestamp` | yes | ISO timestamp generated at action attempt time. |
| `session_id` | yes | Stable operator/assistant/session correlation id. |
| `action_type` | yes | Canonical dotted action id, such as `workflow.deploy`. |
| `parameters` | yes | Raw JSON arguments for server-side forensics. Do not expose this field in user-facing summaries. |
| `args_summary` | yes for `/act` writes | Redacted/truncated summary for display and review. Secret-like keys are replaced with `[redacted]`. |
| `result` | yes | One of `ok`, `blocked`, `error`, or `requires_confirm`. |
| `agent_chain` | yes | Caller provenance, for example `api:admin`, `api:agent:kakashi`, or assistant chain metadata. |
| `error` | no | Error detail for blocked or failed attempts. Must not include raw tokens or secret payloads. |

Authorization failures for audited actions must be recorded as `blocked`.
Confirm-required assistant attempts must be recorded as `requires_confirm` and
must not execute side effects before the confirmation is accepted.

## Token And Secret Handling

- Workflow definitions, cases, work items, and event payloads must store
  connector ids, role ids, document ids, or secret references, not raw provider
  tokens, cookies, passwords, private keys, or webhook secrets.
- Action arguments may contain opaque references to credentials, but audit
  summaries must redact secret-like argument keys. Raw `parameters` are for
  restricted server-side forensics only and must not be echoed to assistant,
  MCP, GUI, or bus responses.
- MCP bridges and agents must pass tokens through injected environment or token
  providers. Tool responses must not log, print, or return bearer tokens.
- Release and preflight scripts must validate route/auth policy and shared
  config without printing secret values.

## Admin Recovery Controls

Admin recovery is allowed only through explicit Action Spine actions or existing
admin-only compatibility routes:

- `case.close`, `case.cancel`, and `case.delete` recover stuck or invalid
  runtime state and are audited.
- `event.confirm` advances a manual event wait and records the confirming actor
  in action arguments.
- `case.start` accepts `admin_override=true` only for tests or migration of
  non-executable workflows. Product and assistant paths must deploy through
  `workflow.deploy` instead.
- `retention.cleanup_apply` and `retention.runtime_cleanup` are admin-only,
  audited cleanup paths and must keep dry-run/preview semantics for review.
- Direct Redis/PostgreSQL surgery is incident response only; when used, the
  operator must create a follow-up issue or audit note that names the affected
  cases, workflows, and reason.

## Release Gate

Before release or broad workflow-runtime changes, the gate must verify:

1. `bun run scripts/action-surface-report.ts --check`
2. `python3 scripts/check-route-auth-policy.py`
3. `bun x tsc --noEmit`
4. Relevant Action Spine and workflow lifecycle tests
5. Secret/config validation that does not print secret values

`scripts/pre-release-gate.py` includes the first two checks as the
`action_security_boundary` gate. A release is blocked if the generated action
surface drifts or high-risk route authorization loses its admin/self boundary.
