# Workflow Constructor/Runtime Release Checklist

Issue #751 defines the reviewer checklist for constructor, editor, Action
Spine, runtime, persistence, connector, and deployment PRs that feed #686
Workflow Engine release signoff. The machine-readable contract is
`docs/workflow-constructor-runtime-release-checklist.json`.

This checklist depends on `docs/release-policy.md`,
`docs/workflow-engine-preflight-tiers.md`, and
`docs/workflow-runtime-rollback-recovery.md`. It does not replace Shikadai
review, #686, or the #812 terminal-case fix.

## When To Use

Use this checklist when a PR or issue touches any of:

- workflow editor or constructor UX;
- Action Spine action definitions, executors, MCP bridge, or compatibility
  mutation routes;
- case lifecycle, dispatcher, gateway/runtime behavior, work items, waits,
  subscriptions, reminders, or event handling;
- workflow deploy, trigger materialization, subscriptions, or partial deploy
  recovery;
- Redis runtime state, PostgreSQL shadow writes, `PG_READ`, retention, or test
  storage;
- connector/outbox/external dispatch effects;
- machine-readable runbooks or docs that change operator behavior.

Docs-only changes may use the docs-only exception below when they do not change
runtime behavior and have a contract test if the document is a source of truth.

## Core Reviewer Questions

| Check | Required evidence |
| --- | --- |
| Stable contract | Action ID, typed route contract, generated surface, or source-of-truth doc. No ad hoc route, MCP, or UI-only behavior for durable mutations. |
| Success and failure tests | Focused command plus success and negative/failure assertions where applicable. |
| M1 isolation | Storage/test changes prove no Redis DB `0`, PostgreSQL `public`, or production connector contamination. |
| Staging-core | Broad runtime/deploy/connector/release changes attach `scripts/staging-smoke.sh --dry-run` and live staging evidence or waiver. |
| Rollback/recovery | Runtime changes cite `docs/workflow-runtime-rollback-recovery.md`, include rollback command, data rollback limit, and scenario id when applicable. |
| #812 terminal-case rule | Changes that route work, waits, subscriptions, or dispatch effects prove terminal cases do not receive new work, or record explicit non-applicability. |
| Action Spine/security boundary | User-visible mutations go through Action Spine or an accepted compatibility executor with matching auth/audit. |
| Parent receipt | #686 or the child issue receives commit hash, checklist class ids, commands, artifacts, blockers, warnings, and waivers. |

## Change Classes

| Class | Applies to | Portable CI evidence | Production-only evidence |
| --- | --- | --- | --- |
| `constructor-editor` | workflow editor, constructor UI, assistant editor UX, schema patch UI | fast-local tier; browser-e2e when UI behavior changes; isolated integration for release | production-smoke only for normal production release or deployed UI change |
| `workflow-runtime` | cases, dispatcher, gateways, waits, reminders, work items | fast-local and isolated integration tiers | production-smoke and `pg-verify` when persisted runtime entities change |
| `action-spine-mutation` | action ids, args, security, MCP action bridge, compatibility mutations | `bun run scripts/action-surface-report.ts --check`, `python3 scripts/check-route-auth-policy.py`, focused executor tests | production-smoke only when deployed action affects production runtime |
| `deployment-subscription` | `workflow.validate`, `workflow.deploy`, triggers, subscriptions, partial deploys | staging smoke dry-run, validation receipt negative cases, and Action Spine surface check | production-smoke and `pg-verify` |
| `storage-pg-shadow` | Redis state, PG shadow writes, `PG_READ`, factories, retention | M1 storage guardrails and Redis/PG isolation contracts | `pg-verify` and production preflight |
| `connector-outbox-effects` | Telegram, messenger connectors, outbox, external dispatch | messenger/connector contract tests and Action Spine surface check | Telegram smoke and healthcheck connector profile |
| `docs-only-exception` | docs, runbooks, architecture policy, machine-readable docs | focused doc contract test and `json.tool` when JSON changes | none unless release notes/tag are created |

## Commands

Portable commands. Use the relevant subset for focused review and
`scripts/preflight-portable.sh` for normal release evidence:

```bash
scripts/preflight-portable.sh
bun test --timeout 30000 tests/workflow-loader-validation.test.ts tests/act-workflow-executor.test.ts tests/eepc-state-machine-regression.test.ts tests/event-activation-policy.test.ts tests/event-waits-list.test.ts tests/runtime-condition-eval.test.ts
bun run scripts/action-surface-report.ts --check
python3 scripts/check-route-auth-policy.py
scripts/staging-smoke.sh --dry-run
```

Golden-path acceptance evidence for #685/#745/#746/#747/#748:

```bash
bun test --timeout 30000 tests/golden-path-acceptance-closure-report.test.ts
bun test --timeout 30000 tests/assistant-create-validate-deploy-run-fixture.test.ts
bun test --timeout 30000 tests/backend-golden-path.test.ts
ANTHROPIC_API_KEY=ci-placeholder bun x playwright test e2e/AssistantWidgetGoldenPath-747.spec.ts --config=playwright.config.ci.ts
```

This fixture uses `assistant.invoke` with a deterministic `fixture_response`
containing an Action Spine `action_sequence`. It creates an explicit manual
role, creates a workflow, validates the canonical readiness receipt, deploys
through `workflow.deploy`, starts a case through `case.start`, and asserts the
assigned work item and monitor navigation receipt without calling a live LLM.
The backend golden-path companion covers the same durable create, validate,
deploy, run, work item, and dispatch receipt path without browser dependencies.
The browser E2E companion verifies AssistantWidget, ProcessEditor reload
persistence, deploy/run controls, and Work Items operator visibility. The
machine-readable #685 parent closure receipt is
`docs/golden-path-acceptance-closure-report.json`; human-readable evidence is
`docs/golden-path-acceptance-closure-report.md`.

Production-only commands. Do not require these from portable CI:

```bash
scripts/preflight.sh
KONOHA_SERVICE_PROFILE=prod-core python3 scripts/healthcheck-system.py
bun run scripts/pg-verify.ts
scripts/telegram-smoke.sh
```

Storage isolation evidence for M1:

```bash
bun test --timeout 30000 tests/test-storage-guardrails.test.ts tests/redis-test-isolation-contract.test.ts tests/pg-test-isolation-contract.test.ts tests/test-factory-namespace.test.ts tests/staging-environment.test.ts
```

## Blockers And Warnings

Blockers:

- durable mutation is implemented only as ad hoc UI, MCP, or bespoke route;
- Action Spine mutation lacks auth/audit/confirmation evidence;
- runtime change can route new work, waits, subscriptions, or dispatch effects
  to closed/terminal cases;
- workflow deploy/start changes do not surface the canonical `workflow.validate`
  receipt with stable blocking error codes;
- `pg-verify` reports `onlyInRedis > 0`;
- tests or staging touch Redis DB `0`, PostgreSQL `public`, or production
  connectors without an accepted destructive/connector waiver;
- external resend lacks owner approval or idempotency evidence;
- destructive data cleanup lacks owner/operator and Shikadai acceptance plus
  dry-run evidence;
- requested Shino/Hinata branch has not reported pass/fail.

Warnings:

- `pg-verify` `onlyInPG` bloat when `onlyInRedis=0`;
- optional worker, TestBench, or connector disabled by service profile as
  intended;
- browser tier not applicable to backend-only/docs-only changes;
- live staging unavailable with a time-boxed waiver and dry-run evidence;
- docs-only change does not require production preflight.

## Waiver Wording

Use this exact shape when Shikadai or the owner accepts a skipped gate:

```text
Workflow constructor/runtime checklist waiver for #<issue>.
Skipped gate(s): <list>.
Reason safe: <why the skipped gate is not required for this change>.
Replacement evidence: <commands/artifacts>.
Risk accepted: <runtime/user/data impact>.
Rollback owner and command: <owner + command>.
Expires: <date/time>.
```

A staging waiver must not enable production connectors or weaken `prod-core`.
An emergency release bypass still uses the stronger wording in
`docs/release-policy.md`.

## Dispatch And Escalation

Default path remains Developer Kakashi -> Reviewer Shikadai. Do not notify
Shino, Hinata, or Guy by default.
The broader architecture delivery model is defined in
`docs/konoha-delivery-model.md`.

Escalate only when Shikadai explicitly requests it:

- Shino: `state:ready-for-test` test-plan escalation and QA report.
- Hinata: bounded browser/TestBench execution from a reviewer-approved plan.
- Guy: mechanical docs/template work only when explicitly requested.

## Review Handoff

For every constructor/runtime PR or child issue, attach:

- issue number and commit hash;
- checklist class id(s);
- exact commands and pass/fail result;
- generated artifacts such as Playwright report, staging smoke output,
  `pg-verify`, healthcheck, Action Spine receipts, or connector receipts;
- blockers, warnings, and waiver text;
- rollback command and data rollback limit;
- #686 receipt link when the work contributes to release signoff.
