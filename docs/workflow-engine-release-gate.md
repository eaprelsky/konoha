# Workflow Engine Release Gate

Date: 2026-05-22

Issue #686 is the Workflow Engine production-readiness gate. It collects the
accepted constructor-to-runtime evidence and defines the exact blockers,
warnings, rollback evidence, and review commands required before a Workflow
Engine release can be claimed.

Machine-readable contract: `docs/workflow-engine-release-gate.json`.

## Decision

#686 can close after Shikadai accepts this gate and runbook. Closing it does not
create a production release, does not tag a version, does not approve an owner
bypass, does not extract Action Spine packages, and does not close or unpause
#812.

Normal production release still requires:

- Shikadai acceptance for the release commit/evidence;
- owner/operator approval;
- `scripts/preflight-portable.sh`;
- `scripts/preflight.sh`;
- `scripts/pre-release-gate.py`;
- `pg-verify` with `onlyInRedis=0`;
- prod-core healthcheck with no required-service `FAIL`;
- rollback/recovery evidence from `docs/workflow-runtime-rollback-recovery.md`;
- version, changelog, tag, and GitHub release artifacts when the release is
  versioned.

## Accepted Evidence

| Issue | Capability | Evidence |
| --- | --- | --- |
| #672 | BPMS architecture closure | `docs/bpms-architecture-closure-report.json` |
| #675 | Durable assistant edits | `tests/workflow-patch-service.test.ts`, `tests/assistant-response.test.ts` |
| #678 | Runtime side-effect outbox | `docs/runtime-effect-outbox-closure-report.json` |
| #679 | Role readiness and dispatch targets | `docs/role-readiness-closure-report.json` |
| #680 | Deterministic state-machine core | `docs/state-machine-core-closure-report.json` |
| #681 | Observability, recovery, retry controls | `docs/operator-run-observability-closure-report.json` |
| #683 | PG_READ consistency and retention gate | `docs/pg-read-consistency-closure-report.json` |
| #684 | Action Spine extraction readiness | `docs/action-spine-extraction-closure-report.json` |
| #685 | Golden-path acceptance | `docs/golden-path-acceptance-closure-report.json` |

## Blockers

The following block Workflow Engine release signoff:

- required portable preflight fails;
- golden-path assistant/backend/browser evidence fails;
- Action Spine surface or route-auth policy drifts;
- staging-core isolation fails or waiver enables production connectors;
- production preflight fails for a normal production release;
- `pg-verify` reports `onlyInRedis > 0`;
- prod-core healthcheck reports a required-service `FAIL`;
- rollback/recovery scenario, command, destructive-data gate, or audit evidence
  is missing;
- Shikadai acceptance or owner/operator production approval is missing;
- a change can route new work, waits, subscriptions, reminders, dispatch
  effects, or recovery retries to terminal cases without proving the #812 rule
  still holds.

## Warnings

Warnings require release-note acknowledgement but do not automatically block
when the corresponding blocker is absent:

- `onlyInPG` bloat with `onlyInRedis=0`;
- optional workers, TestBench, browser, or external connector disabled by the
  selected service profile;
- known infra WARNs already recorded in the issue/release note;
- browser tier is not applicable for backend-only or docs-only changes.

## Rollback And Recovery

Use `docs/workflow-runtime-rollback-recovery.md` as the operator runbook. A
release handoff must include the matching scenario id and evidence for:

- failed deploy or partial deploy;
- stuck work item or running case;
- failed runtime effect;
- PG/Redis divergence.

Code rollback is `git revert <bad_commit>` plus `git push origin main`.
Runtime state rollback is not implicit: Redis cases, work items, subscriptions,
waits, reminders, outbox effects, bus streams, and external connector sends
must be recovered through Action Spine/admin APIs with receipts and audit.

## #812 Terminal-Case Gate

#812 remains open and paused by Yegor. #686 does not waive it.

Release signoff must not route new work, waits, subscriptions, reminders,
dispatch effects, or recovery retries to closed/done/cancelled/error terminal
cases. If a release touches any path that could do that, the evidence must
either prove the path cannot bypass the terminal-case rule or list #812 as an
unresolved blocker for that release.

## Review Commands

```bash
python3 -m json.tool docs/workflow-engine-release-gate.json >/dev/null
python3 -m json.tool docs/workflow-engine-preflight-tiers.json >/dev/null
python3 -m json.tool docs/workflow-runtime-rollback-recovery.json >/dev/null
python3 -m json.tool docs/workflow-constructor-runtime-release-checklist.json >/dev/null
python3 -m json.tool docs/golden-path-acceptance-closure-report.json >/dev/null
PATH=/home/ubuntu/.bun/bin:$PATH bun test --timeout 30000 tests/workflow-engine-release-gate.test.ts tests/release-policy.test.ts tests/workflow-engine-preflight-tiers.test.ts tests/workflow-runtime-rollback-recovery.test.ts tests/workflow-constructor-runtime-release-checklist.test.ts tests/golden-path-acceptance-closure-report.test.ts tests/bpms-architecture-closure-report.test.ts tests/runtime-effect-outbox-closure-report.test.ts tests/role-readiness-closure-report.test.ts tests/state-machine-core-closure-report.test.ts tests/operator-run-observability-closure-report.test.ts tests/pg-read-consistency-closure-report.test.ts tests/action-spine-extraction-closure-report.test.ts
PATH=/home/ubuntu/.bun/bin:$PATH bun test --timeout 30000 tests/assistant-create-validate-deploy-run-fixture.test.ts tests/backend-golden-path.test.ts
ANTHROPIC_API_KEY=ci-placeholder PATH=/home/ubuntu/.bun/bin:$PATH bun x playwright test e2e/AssistantWidgetGoldenPath-747.spec.ts --config=playwright.config.ci.ts
PATH=/home/ubuntu/.bun/bin:$PATH bun run scripts/action-surface-report.ts --check
python3 scripts/check-route-auth-policy.py
PATH=/home/ubuntu/.bun/bin:$PATH bun run typecheck
git diff --check
```
