# State-Machine Core Parent Closure Report

Issue #680 is the parent umbrella for deterministic case advancement and the
runtime effect boundary. The machine-readable closure receipt is
`docs/state-machine-core-closure-report.json`.

## Closure Invariant

Case advancement graph navigation is planned by a deterministic pure
state-machine core. Runtime side effects are emitted as explicit intents or
contracts and applied outside the planner boundary.

## Covered Surfaces

| Surface | Contract |
| --- | --- |
| Pure graph planner | `src/runtime/cases/transition-planner.ts` plans next state from workflow, case position/history, and payload without Redis, adapters, Telegram, real agents, or persistence. |
| Gateway split/join | XOR, AND, and OR decisions use the same planner path, with branch work-item intents and join reachability covered by fixtures. |
| Runtime applicator | `src/runtime/cases/advancement.ts` persists case state and applies work-item, wait/subscription, adapter, outbox, subprocess, and cleanup boundaries. |
| Subprocess effects | `src/runtime/cases/subprocess-effects.ts` exposes explicit `subprocess.spawn` and `subprocess.parent_complete` contracts. |
| Regression fixtures | `tests/fixtures/state-machine-transition-fixtures.ts` captures deterministic branch, wait, loop, terminal, and malformed transition cases. |

## Child Evidence

Closed detailed slices: #725, #726, #727, and #728.

Those slices cover the original #680 acceptance criteria for Redis-free
state-machine tests, deterministic transition outputs, explicit side-effect
intents, gateway split/join deduplication, and subprocess transition/effect
contracts.

## Boundaries Kept

The planner may emit intent kinds such as `function.work_item`, `event.wait`,
`case.complete`, `case.error`, and `gateway.evaluated`. Subprocess behavior uses
separate effect contracts. The planner must not dispatch work, enqueue outbox
records, create waits, subscribe events, call adapters, spawn subprocess cases,
or write Redis/PostgreSQL.

## Review Commands

```bash
PATH=/home/ubuntu/.bun/bin:$PATH bun test --timeout 30000 \
  tests/state-machine-core-closure-report.test.ts \
  tests/graph-transition-planner.test.ts \
  tests/state-machine-transition-fixtures.test.ts \
  tests/subprocess-transition-effects.test.ts \
  tests/eepc-state-machine-regression.test.ts

PATH=/home/ubuntu/.bun/bin:$PATH bun test --timeout 30000 \
  tests/workflow-lifecycle-gate.test.ts \
  tests/backend-golden-path.test.ts

PATH=/home/ubuntu/.bun/bin:$PATH bun run scripts/action-surface-report.ts --check
python3 scripts/check-route-auth-policy.py
PATH=/home/ubuntu/.bun/bin:$PATH bun run typecheck
```

## Closure Recommendation

#680 can close after Shikadai review as the deterministic state-machine core
and effect-boundary umbrella. This does not bypass the #686 release process or
the #812 terminal-case gate.
