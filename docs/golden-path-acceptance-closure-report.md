# Golden Path Acceptance Closure Report

Date: 2026-05-22

Issue #685 reconciles the accepted #745, #746, #747, and #748 evidence for the
AI constructor -> validate -> deploy -> run -> assigned work item promise. This
is the M6 acceptance parent for the product golden path; it is not the final
production release gate, which remains #686.

## Closure Decision

The golden path is ready for Shikadai parent review:

- #745 proves deterministic `assistant.invoke` execution without a live LLM.
- #746 proves backend Action Spine contracts persist and execute the durable
  workflow path.
- #747 proves the browser path through AssistantWidget, ProcessEditor reload,
  deploy/run controls, and Work Items operator visibility.
- #748 proves invalid, non-executable, failed deploy, and failed dispatch paths
  do not claim runnable success.

The accepted invariant is that a workflow only counts as runnable when durable
Action Spine receipts exist for workflow creation, validation, deployment, case
start, first work item creation, and dispatch evidence. Client-only canvas
state, textual assistant output, preview patches, partial deploy failure, and
failed dispatch are not accepted as success.

## Acceptance Map

| Golden-path step | Evidence | Guard against fake success |
| --- | --- | --- |
| Durable workflow definition | `tests/assistant-create-validate-deploy-run-fixture.test.ts`, `tests/backend-golden-path.test.ts`, `e2e/AssistantWidgetGoldenPath-747.spec.ts` | Browser reload verifies persisted workflow state. |
| Graph/runtime readiness | `tests/backend-golden-path.test.ts` | Invalid role, trigger, and graph cases return stable blockers. |
| Role assignment/request | `tests/assistant-create-validate-deploy-run-fixture.test.ts`, `tests/backend-golden-path.test.ts` | Missing-role workflow blocks deploy and start. |
| Deploy triggers/effects | `tests/backend-golden-path.test.ts` | Failed side effects demote workflow and block start. |
| Start case | `tests/assistant-create-validate-deploy-run-fixture.test.ts`, `tests/backend-golden-path.test.ts`, `e2e/AssistantWidgetGoldenPath-747.spec.ts` | `case.start` before executable state returns `WORKFLOW_NOT_EXECUTABLE`. |
| First work item and dispatch | `tests/backend-golden-path.test.ts`, `e2e/AssistantWidgetGoldenPath-747.spec.ts` | Dispatch effect and target details are persisted; failed dispatch becomes dead-letter. |
| Receipts and monitor navigation | `tests/assistant-create-validate-deploy-run-fixture.test.ts`, `e2e/AssistantWidgetGoldenPath-747.spec.ts` | Assistant normalized response and operator Work Items view are asserted. |

## Review Evidence

Machine-readable evidence lives in
`docs/golden-path-acceptance-closure-report.json`. The focused parent regression
is `tests/golden-path-acceptance-closure-report.test.ts`.

Reviewer command set:

```bash
python3 -m json.tool docs/golden-path-acceptance-closure-report.json >/dev/null
PATH=/home/ubuntu/.bun/bin:$PATH bun test --timeout 30000 tests/golden-path-acceptance-closure-report.test.ts tests/assistant-create-validate-deploy-run-fixture.test.ts tests/backend-golden-path.test.ts
ANTHROPIC_API_KEY=ci-placeholder PATH=/home/ubuntu/.bun/bin:$PATH bun x playwright test e2e/AssistantWidgetGoldenPath-747.spec.ts --config=playwright.config.ci.ts
PATH=/home/ubuntu/.bun/bin:$PATH bun run scripts/action-surface-report.ts --check
python3 scripts/check-route-auth-policy.py
PATH=/home/ubuntu/.bun/bin:$PATH bun run typecheck
git diff --check
```

Closing #685 unblocks #686 release-gate review evidence. #618 package
extraction still requires #686 and its release signoff.
