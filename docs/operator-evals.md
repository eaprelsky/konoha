# Operator Evaluation Harness

Reference line: `#525`, `#526`, `#530`, `#533`, `#534`

This harness exists to measure the canonical operator loop for Tsunade and future AI operators:

1. read canonical `operator_state`
2. emit assistant output
3. normalize it into canonical actions/results
4. execute allowed side effects
5. verify observable and auditable system result

## Why this exists

Unit tests around isolated helpers are not enough for the AI-native operator line.

We need repeatable benchmarks that catch regressions in:

- action materialization
- confirmation semantics
- observable receipts/results
- malformed-output fallback behavior

## Current benchmark scenarios

The suite currently covers:

- materialized `workflow.create` draft path
- confirm-required `workflow.create` path
- malformed/fallback output path with `no_effect`

These benchmarks are implemented in [tests/operator-evals.test.ts](/home/ubuntu/konoha/tests/operator-evals.test.ts:1) and run through the reusable harness in [src/operator-evals.ts](/home/ubuntu/konoha/src/operator-evals.ts:1).

## How to run

```bash
bun test tests/operator-evals.test.ts
```

Or run the full unit suite:

```bash
bun test
```

## How to extend

Add a new scenario when the operator contract gains a new canonical capability. Prefer scenarios that assert a system result, not only transport shape.

Good additions:

- trigger mutation with canonical `trigger.set`
- recovery from invalid mixed JSON/text output
- multi-action turns that end in `partial`
- future non-Tsunade operators using the same state/action/result surface
