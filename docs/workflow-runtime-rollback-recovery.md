# Workflow Runtime Rollback And Recovery Runbook

Issue #750 defines the Workflow Engine runtime rollback and recovery runbook
for #686 release signoff. The machine-readable contract is
`docs/workflow-runtime-rollback-recovery.json`; this document is the operator
procedure.

This runbook inherits `docs/release-policy.md`,
`docs/workflow-engine-preflight-tiers.md`, `docs/workflow-security-boundary.md`,
and the #753 staging-core contract. It does not unpause or close #812.

## Core Rules

- Redis remains the active Workflow Engine runtime store for cases, work items,
  subscriptions, waits, reminders, streams, and in-flight dispatch receipts.
- PostgreSQL is shadow/durable evidence until a separately accepted `PG_READ`
  cutover. `pg-verify` `onlyInRedis > 0` is a blocker. `onlyInPG` bloat with
  `onlyInRedis=0` is a warning/retention item.
- Code rollback does not rewind Redis state, PostgreSQL shadow rows,
  subscriptions, reminders, work items, outbox entries, Konoha bus streams, or
  external connector messages already sent.
- Closed, done, cancelled, error, or otherwise terminal cases must not receive
  new work, new tasks, new event waits, or subscription resumes. This reflects
  the #812 terminal-case rule while #812 remains paused by Yegor.
- Runtime recovery mutations must use Action Spine or existing admin APIs so
  receipts and audit records exist.
- Destructive data changes are not normal rollback. They require explicit
  owner/operator acceptance, Shikadai acceptance, dry-run evidence, exact object
  scope, and a Konoha bus audit message.

## First Response

Run these before mutating runtime state:

```bash
cd /home/ubuntu/konoha
PATH=/home/ubuntu/.bun/bin:$PATH bun run scripts/pg-verify.ts
KONOHA_SERVICE_PROFILE=prod-core python3 scripts/healthcheck-system.py
bun run scripts/action-surface-report.ts --check
python3 scripts/check-route-auth-policy.py
```

For broad runtime or release rollback, also run the selected tier from
`docs/workflow-engine-preflight-tiers.md`:

```bash
scripts/preflight-portable.sh
scripts/staging-smoke.sh --dry-run
scripts/preflight.sh
```

If `pg-verify` reports `onlyInRedis > 0`, stop the release or rollback handoff
until the missing shadow writes are explained or reconciled. If a case is
terminal and still receives work, stop dispatch recovery and quarantine the case
evidence for the #812 follow-up.

## Runtime State Limits

| Boundary | Rollback limit | Recovery path |
| --- | --- | --- |
| Redis active state | Active cases, work items, waits, reminders, streams, and dispatch receipts are not reverted by `git revert`. | Inspect, then use `case.cancel`, `case.close`, `workitem.cancel/update`, `subscription.cancel`, or approved idempotent reconcile. |
| PostgreSQL shadow state | PG is evidence until accepted `PG_READ` cutover. | Use `pg-verify`; use `bun run scripts/reconcile-pg-bus.ts --dry-run` before any apply. |
| Subscriptions and event waits | Live resume points may still fire after code rollback. | List waits/subscriptions by case; cancel exact orphaned subscription ids. |
| Reminders | Fired reminders and queued sends cannot be unsent. | Update status or delete exact reminder ids through Action Spine/admin API. |
| Outbox/dispatch effects | External messages and duplicate sends cannot be unsent. | Stop additional sends, keep receipts, reconcile idempotency keys, and record user impact. |
| Work items | User-visible assignments require audit. | Cancel, complete, or update through `/act`; do not directly edit status. |
| Running cases | Active cases keep their runtime state after deploy rollback. | Cancel/close/quarantine exact case ids; do not start replacement cases before duplicate-dispatch review. |

## Recovery Scenarios

### Stuck Running Case

Use when a case is `running` past SLA, has a stale wait, or has work assigned to
an unreachable role/agent.

```bash
bun run scripts/pg-verify.ts
curl -sS -X POST "$KONOHA_URL/act" -H "Authorization: Bearer $KONOHA_TOKEN" -H "Content-Type: application/json" -d '{"action":"case.get","category":"inspect","args":{"id":"<case_id>"}}'
curl -sS -X POST "$KONOHA_URL/act" -H "Authorization: Bearer $KONOHA_TOKEN" -H "Content-Type: application/json" -d '{"action":"case.cancel","category":"act","args":{"id":"<case_id>","reason":"stuck-running-case recovery issue #<incident>"}}'
curl -sS -X POST "$KONOHA_URL/act" -H "Authorization: Bearer $KONOHA_TOKEN" -H "Content-Type: application/json" -d '{"action":"workitem.cancel","category":"act","args":{"id":"<work_item_id>"}}'
```

Blockers: terminal case has new routed work; `onlyInRedis > 0`; destructive
cleanup lacks owner/reviewer acceptance.

Evidence: case id, work item ids, before/after case state, `pg-verify` output,
Action Spine receipts, and Konoha bus review message.

### Orphaned Waits Or Subscriptions

Use when waits/subscriptions reference missing or terminal cases.

```bash
curl -sS -X POST "$KONOHA_URL/act" -H "Authorization: Bearer $KONOHA_TOKEN" -H "Content-Type: application/json" -d '{"action":"case.get","category":"inspect","args":{"id":"<case_id>"}}'
curl -sS -X POST "$KONOHA_URL/act" -H "Authorization: Bearer $KONOHA_TOKEN" -H "Content-Type: application/json" -d '{"action":"subscription.list","category":"inspect","args":{}}'
curl -sS -X POST "$KONOHA_URL/act" -H "Authorization: Bearer $KONOHA_TOKEN" -H "Content-Type: application/json" -d '{"action":"subscription.cancel","category":"act","args":{"id":"<subscription_id>"}}'
```

Abort if the subscription owner cannot be identified or cancellation would hide
the #812 terminal-case violation instead of preserving evidence.
`event.wait_list` is still a planned Action Spine surface; use it only after an
implementation is accepted, otherwise rely on `case.get` plus
`subscription.list` evidence.

### Duplicate Dispatch

Use when two task messages, connector receipts, or agent acknowledgements point
to the same `work_item_id`.

```bash
curl -sS -X POST "$KONOHA_URL/act" -H "Authorization: Bearer $KONOHA_TOKEN" -H "Content-Type: application/json" -d '{"action":"workitem.list","category":"inspect","args":{"case_id":"<case_id>"}}'
KONOHA_SERVICE_PROFILE=prod-core python3 scripts/healthcheck-system.py
bun run scripts/action-surface-report.ts --check
```

Do not delete duplicate messages from streams. Keep both receipts, determine
which effect was first, and stop before any external resend unless the owner
accepts duplicate-send risk.

### Failed Connector

Use when a connector send fails, an outbox/dead-letter entry exists, or
healthcheck reports connector `FAIL`.

```bash
KONOHA_SERVICE_PROFILE=prod-core python3 scripts/healthcheck-system.py
scripts/telegram-smoke.sh
curl -sS -X POST "$KONOHA_URL/act" -H "Authorization: Bearer $KONOHA_TOKEN" -H "Content-Type: application/json" -d '{"action":"connector.send_message","category":"act","args":{"connector_id":"<connector_id>","endpoint_id":"<endpoint_id>","chat_ref":"<provider_chat_ref>","text":"<approved recovery message>","dry_run":true,"metadata":{"idempotency_key":"<case_id>:<work_item_id>:recovery","incident":"#<incident>"}}}'
```

Blockers: no idempotency key; no owner approval for external resend; connector
is disabled by the selected service profile.

### Partial Deploy Or Failed Deploy

Use when the code deploy, workflow deploy, subscriptions, or snapshots are only
partially applied.

```bash
git revert <bad_commit>
git push origin main
scripts/preflight-portable.sh
scripts/preflight.sh
bun run scripts/pg-verify.ts
```

For workflow deploy investigation:

```bash
bun run scripts/action-surface-report.ts --check
python3 scripts/check-route-auth-policy.py
scripts/staging-smoke.sh --dry-run
curl -sS -X POST "$KONOHA_URL/act" -H "Authorization: Bearer $KONOHA_TOKEN" -H "Content-Type: application/json" -d '{"action":"workflow.get","category":"inspect","args":{"id":"<workflow_id>"}}'
curl -sS -X POST "$KONOHA_URL/act" -H "Authorization: Bearer $KONOHA_TOKEN" -H "Content-Type: application/json" -d '{"action":"workflow.deploy","category":"act","args":{"id":"<workflow_id>"}}'
```

Blockers: `onlyInRedis > 0`; active cases exist on the partially deployed
workflow and need case-level recovery; route auth check fails; deploy action is
not audited.

### Invalid Workflow Update

Use when an accepted workflow update creates invalid graph/runtime behavior.

```bash
bun test --timeout 30000 tests/workflow-loader-validation.test.ts tests/eepc-state-machine-regression.test.ts
curl -sS -X POST "$KONOHA_URL/act" -H "Authorization: Bearer $KONOHA_TOKEN" -H "Content-Type: application/json" -d '{"action":"workflow.get","category":"inspect","args":{"id":"<workflow_id>"}}'
curl -sS -X POST "$KONOHA_URL/act" -H "Authorization: Bearer $KONOHA_TOKEN" -H "Content-Type: application/json" -d '{"action":"workflow.update","category":"act","args":{"id":"<workflow_id>","elements":[{"id":"<event_id>","type":"event","label":"<label>"}],"flow":[],"draft":true}}'
```

Apply only the reviewed definition payload. The current `workflow.update`
Action Spine schema does not accept `patch` or `dry_run`; use `workflow.get`
before/after evidence and staging/preflight checks as the review guard. Abort if
active cases are unknown or the payload would create/route work for terminal
cases.

### Bad Assistant Action

Use when an assistant proposes or performs an unsafe mutation.

```bash
bun run scripts/action-surface-report.ts --check
python3 scripts/check-route-auth-policy.py
curl -sS -X POST "$KONOHA_URL/act" -H "Authorization: Bearer $KONOHA_TOKEN" -H "Content-Type: application/json" -d '{"action":"audit.read","category":"inspect","args":{"action_type":"assistant.invoke","limit":50}}'
```

Blockers: mutating action bypassed confirmation; audit record is missing.
Warnings: proposal was rejected before side effects.

### PostgreSQL/Redis Divergence

Use when `pg-verify` reports runtime storage drift.

```bash
bun run scripts/pg-verify.ts
bun run scripts/reconcile-pg-bus.ts --dry-run
bun run scripts/reconcile-pg-bus.ts
```

The apply command is allowed only after dry-run output matches the incident
scope and Shikadai accepts it. `onlyInRedis > 0` blocks release. `onlyInPG`
bloat with `onlyInRedis=0` is a warning.

## Destructive Data Gate

These commands are never acceptable as broad Workflow Engine recovery:

```text
FLUSHDB
FLUSHALL
DROP DATABASE
DROP SCHEMA public
redis-cli --scan | xargs redis-cli del
```

The following are allowed only with exact object scope, owner/operator
acceptance, Shikadai acceptance, dry-run evidence, and an issue audit trail:

- `retention.cleanup_apply`
- `retention.runtime_cleanup`
- `case.delete`
- `reminder.delete`

The audit trail must include issue number, owner, reviewer, exact affected ids,
commands, receipts, before/after state, blockers/warnings, abort criteria, and
Konoha bus messages to Naruto and Shikadai.

## Review Handoff

For Shikadai review or #686 release signoff, include:

- issue number and commit hash;
- scenario id from `docs/workflow-runtime-rollback-recovery.json`;
- exact commands run and pass/fail result;
- evidence artifacts: `pg-verify`, healthcheck, preflight/staging smoke,
  Action Spine receipts, connector receipts, and before/after runtime state;
- blockers vs warnings;
- explicit rollback/abort criteria;
- destructive-data waiver text, if any.
