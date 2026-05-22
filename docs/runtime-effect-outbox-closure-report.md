# Runtime Effect Outbox Parent Closure Report

Issue #678 is the parent umbrella for durable runtime side effects. The
machine-readable closure receipt is
`docs/runtime-effect-outbox-closure-report.json`.

## Closure Invariant

Runtime state may record progress only when the intended side effects are
durably represented by runtime effect records, or when the path is explicitly
documented as synchronous/direct because the runtime needs immediate
deterministic output.

## Covered Surfaces

| Surface | Durable contract |
| --- | --- |
| Work item dispatch | `workitem.dispatch` effects, delivery receipts, duplicate notification suppression, branch and normal advancement coverage. |
| Connector notifications | `connector.send_message` effects, delivered receipt dedupe, retry/dead-letter worker handling. |
| Adapter execution | `adapter.invoke` for bindings marked `execution: "async_effect"`; sync bindings remain direct for deterministic output. |
| Subscriptions/reminders | `subscription.create`, `subscription.cancel`, and `reminder.schedule` effects for scheduler/listener resources. |
| Retry/dead-letter | Shared `RuntimeEffectRecord` status machine, lock recovery, idempotency indexes, and bounded attempts. |
| Recovery/observability | Runtime effect timeline events, Monitor/alert views, admin recovery API/CLI, and audit-linked recovery receipts. |

## Child Evidence

Closed detailed slices: #715, #716, #717, #718, #719, #720, #729, #730, #731,
and #732.

Those slices cover the original #678 acceptance criteria for durable effects,
retry/dead-letter/idempotency, failed side-effect observability, and safe
recovery. This parent pass also wires the previously reserved
`connector.send_message` effect into the shared worker surface.

## Direct Paths Kept

Some paths intentionally remain direct:

- sync adapter bindings, when output is needed to complete work, update payload,
  or drive gateways;
- manual subscriptions/direct admin subscription commands where no scheduler
  resource is needed;
- explicit operator `connector.send_message` Action Spine calls.

These are direct because they are synchronous source-of-truth operations, not
silent fire-and-forget runtime effects.

## Review Commands

```bash
PATH=/home/ubuntu/.bun/bin:$PATH bun test --timeout 30000 \
  tests/runtime-effect-outbox.test.ts \
  tests/connector-outbox.test.ts \
  tests/workitem-dispatch-outbox.test.ts \
  tests/adapter-outbox.test.ts \
  tests/scheduled-effects-outbox.test.ts \
  tests/runtime-effect-recovery.test.ts \
  tests/operational-alerts.test.ts

PATH=/home/ubuntu/.bun/bin:$PATH bun test --timeout 30000 \
  tests/workflow-deployment-service.test.ts \
  tests/workflow-constructor-runtime-release-checklist.test.ts

PATH=/home/ubuntu/.bun/bin:$PATH bun run scripts/action-surface-report.ts --check
python3 scripts/check-route-auth-policy.py
PATH=/home/ubuntu/.bun/bin:$PATH bun run typecheck
```

## Closure Recommendation

#678 can close after Shikadai review as the durable side-effect outbox umbrella.
This does not bypass the #686 release process or the #812 terminal-case gate.
