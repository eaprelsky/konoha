# BPMS Architecture Program Closure Report

Issue #672 owns the constructor-to-runtime reliability program. The
machine-readable closure evidence is
`docs/bpms-architecture-closure-report.json`.

## Target Invariant

No assistant or operator path may claim execution success unless backend durable
receipts prove both facts:

- the workflow was validated and executable;
- the requested runtime transition actually occurred.

That means `schema_patch` preview is not saved state, `workflow.patch` success
requires a durable commit receipt, `workflow.deploy` success requires
validation, deployed snapshot, and deploy/subscription receipts, and
`case.start` success requires an executable deployed workflow snapshot.

## Completed Evidence

| Milestone | Evidence |
| --- | --- |
| M1 environment isolation | Redis/PG test isolation, staging-core defaults, workflow preflight tiers, delivery model. |
| M2 lifecycle/validation | Canonical validation receipt, lifecycle schema, executable `case.start` gate, validation API/diagnostics. |
| M3 durable edits | Atomic `workflow.patch`, preview vs durable commit semantics, conflict detection, partial failure receipts, direct element/flow/trigger executors. |
| M4 deployment/effects/roles | Transactional deploy, deploy records, subscription diff storage, runtime-effect outbox, work item/adapter/subscription/reminder effects, recovery API/CLI, role readiness/remediation, dispatch target receipts. |
| M5 runtime operations | Pure transition planner, gateway/join dedupe, property-style transition fixtures, subprocess effects, case timeline events, monitor/recovery/audit views, operational alerts, PG_READ readiness, retention policy, rollback runbook, release checklist. |
| M6 acceptance/extraction readiness | Deterministic assistant fixture, backend and browser golden paths, negative golden paths, Action Spine core/vocabulary split, extraction spike. |

The detailed execution issues named in the #672 dispatch are closed and covered
by focused tests. The report records umbrella capability parents #678-#686
separately because several remain `OPEN/state:triage` even though their detailed
child slices are done.

## Gates That Remain Outside This Closure

This report does not claim production release or package extraction readiness:

- #812 remains the terminal-case rule gate. Release/review checklists still
  block changes that route work, waits, subscriptions, or effects to terminal
  cases unless the change proves non-applicability or includes negative tests.
- #618 remains the Action Spine package extraction issue. The generic/core
  boundary is ready, but package movement stays blocked until a separate
  extraction review and package-local bridge tests.
- Umbrella issues #678-#686 may need reviewer label/closure reconciliation if
  Shikadai wants parent capability issues to reflect the accepted detailed
  slices.

## Review Commands

```bash
PATH=/home/ubuntu/.bun/bin:$PATH bun test --timeout 30000 \
  tests/bpms-architecture-closure-report.test.ts \
  tests/workflow-lifecycle-gate.test.ts \
  tests/workflow-validation-taxonomy.test.ts \
  tests/workflow-patch-service.test.ts \
  tests/workflow-deployment-service.test.ts \
  tests/runtime-effect-outbox.test.ts \
  tests/workflow-role-readiness.test.ts \
  tests/backend-golden-path.test.ts \
  tests/runtime-retention-policy.test.ts

PATH=/home/ubuntu/.bun/bin:$PATH bun test --timeout 30000 \
  tests/workflow-constructor-runtime-release-checklist.test.ts \
  tests/workflow-runtime-rollback-recovery.test.ts \
  tests/action-spine-boundary.test.ts \
  tests/pg-read-readiness-report.test.ts

PATH=/home/ubuntu/.bun/bin:$PATH bun run scripts/action-surface-report.ts --check
python3 scripts/check-route-auth-policy.py
python3 -m pytest tests/test_service_profiles.py tests/test_healthcheck_policy.py
PATH=/home/ubuntu/.bun/bin:$PATH bun run typecheck
```

## Closure Recommendation

#672 can close as a consolidation/evidence epic after Shikadai review because
the architecture program has stable receipts, gates, docs, and tests across the
constructor -> validate -> deploy -> run loop.

Do not treat that as:

- approval to release production without the #686 release process;
- approval to unpause or bypass #812;
- approval to start #618 package extraction;
- approval to close #678-#686 umbrella issues without reviewer reconciliation.
