# Operator Run Observability Parent Closure Report

Issue #681 is the parent umbrella for operator-grade runtime observability,
recovery, and retry controls. The machine-readable closure receipt is
`docs/operator-run-observability-closure-report.json`.

## Closure Invariant

Operators can inspect runtime progress, failed effects, waits, recovery actions,
and alerts through durable machine-readable evidence. Failed side effects remain
failed, retryable, or dead-lettered until an explicit audited recovery action
changes state.

## Covered Surfaces

| Surface | Contract |
| --- | --- |
| Timeline evidence | Runtime effect state changes emit `runtime.effect.*`; persisted deploy records emit `workflow.deploy.receipt`. |
| Recovery controls | Admin API and `scripts/runtime-effect-recovery.ts` expose inspect/list/retry/cancel/dead-letter operations with required actor/reason evidence. |
| Audit links | Success and structured failure paths record `runtime_effect.<operation>` audit entries and mirror audit identifiers into recovery receipts and case timeline events. |
| Monitor lane | `MonitorOpsPanel` shows failed/dead-letter/retry effects next to active/overdue/escalated waits, using existing hidden-artifact filters before rendering summaries. |
| Operational alerts | `listOperationalAlerts()` emits deduplicated stuck-case and runtime-effect-failed alerts with severity, correlation, evidence, and recovery paths. |

## Child Evidence

Closed detailed slices: #720, #729, #730, #731, and #732.

Those slices cover the original #681 acceptance criteria for timeline evidence,
failed-effect and waiting-state Monitor views, audit-linked recovery actions,
operational alerts, retry/dead-letter controls, and preserving failed-state
truth until a recovery transition is explicitly accepted.

## Review Commands

```bash
PATH=/home/ubuntu/.bun/bin:$PATH bun test --timeout 30000 \
  tests/operator-run-observability-closure-report.test.ts \
  tests/runtime-effect-recovery.test.ts \
  tests/runtime-effect-outbox.test.ts \
  tests/operational-alerts.test.ts \
  tests/event-waits-list.test.ts

cd frontend && PATH=/home/ubuntu/.bun/bin:$PATH bun run test -- monitorOpsPanel operatorView

PATH=/home/ubuntu/.bun/bin:$PATH bun run scripts/action-surface-report.ts --check
python3 scripts/check-route-auth-policy.py
PATH=/home/ubuntu/.bun/bin:$PATH bun run typecheck
```

## Closure Recommendation

#681 can close after Shikadai review as the operator observability, recovery,
and retry umbrella. This does not bypass the #686 release process or the #812
terminal-case gate.
