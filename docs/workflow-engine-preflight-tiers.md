# Workflow Engine Preflight Tiers

Issue #749 defines the Workflow Engine preflight tiers used by #686 release
signoff. The machine-readable contract is
`docs/workflow-engine-preflight-tiers.json`; this document explains how
Kakashi, Shikadai, Naruto, Shino, and Hinata should use it.

These tiers inherit `docs/release-policy.md`, the #753 staging-core contract,
and the M1 isolation work from #682, #733, #734, #735, and #736. They do not
replace #686. #686 remains the final Workflow Engine release gate/runbook that
collects evidence from these tiers plus the #750 runtime recovery runbook in
`docs/workflow-runtime-rollback-recovery.md`.

## Tier Selection

| Tier | When to run | Command |
| --- | --- | --- |
| `fast-local` | Focused Workflow Engine changes and hotfixes before handoff | `bun test --timeout 30000 tests/workflow-loader-validation.test.ts tests/act-workflow-executor.test.ts tests/eepc-state-machine-regression.test.ts tests/event-activation-policy.test.ts tests/event-waits-list.test.ts tests/runtime-condition-eval.test.ts` |
| `isolated-integration` | Normal release, storage/runtime changes, CI gate | `scripts/preflight-portable.sh` |
| `browser-e2e` | Workflow editor, constructor UX, assistant editor changes | `bunx playwright test` |
| `staging-core` | Broad Workflow Engine changes and pre-production BPMS release evidence | `scripts/staging-smoke.sh --dry-run`; live staging smoke when `/opt/shared/.agent-env.staging` exists |
| `production-smoke` | Normal production release and post-deploy verification | `scripts/preflight.sh` |
| `pg-verify` | Storage, PG shadow, and `PG_READ`/cutover work | `bun run scripts/pg-verify.ts` |
| `healthcheck` | Infra, monitor, lifecycle, and release readiness | `KONOHA_SERVICE_PROFILE=prod-core python3 scripts/healthcheck-system.py` |
| `specialist-qa` | Optional Shikadai-requested QA branch | Reviewer-provided Shino/Hinata test plan |

## Required Evidence

For a release/review note, include:

- tier id(s) run;
- exact commands;
- pass/fail result;
- generated artifacts such as `/tmp/bpms-load-regression-report.json`,
  `/tmp/konoha-data-store-drill-report.json`, Playwright reports, staging
  observation files, `pg-verify` output, or healthcheck summaries;
- blockers, warnings, and waivers.

`scripts/preflight-portable.sh` is the portable CI gate and must not require
production systemd, Telegram credentials, production Redis DB `0`, production
PostgreSQL `public`, or live agent tmux sessions.

`scripts/preflight.sh` is the production gate. It may call live healthcheck,
Telegram smoke, and production `pg-verify`, so it belongs on the production
server or an explicitly approved operator session.

## Blockers And Warnings

Blockers:

- failed tier command for a tier required by the release type;
- M1 isolation contract failure;
- staging env that violates `docs/staging-environment.json`;
- `pg-verify` `onlyInRedis > 0`;
- healthcheck `FAIL` for a required service/profile;
- BPMS load budget failure for the selected profile;
- requested specialist QA branch has not reported pass/fail.

Warnings:

- `pg-verify` `onlyInPG` bloat when `onlyInRedis=0`;
- optional workers or TestBench disabled by service profile;
- known infra WARNs already documented in the issue/release notes;
- browser tier not applicable to backend-only/docs-only changes.

Waivers must use the wording and risk acceptance rules from
`docs/release-policy.md`. A staging waiver must not enable production
connectors or weaken `prod-core`.

## Relationship To #686

#749 is the M1 preflight scaffold. #750 adds runtime rollback/recovery evidence
through `docs/workflow-runtime-rollback-recovery.md`; #751 adds
constructor/runtime checklist evidence. #686 is the final Workflow Engine
release gate/runbook and should reference the tier ids from
`docs/workflow-engine-preflight-tiers.json` instead of redefining separate
ad hoc gates.

## Operator Notes

- Use `fast-local` before asking Shikadai to review a focused workflow change.
- Use `isolated-integration` for normal CI evidence.
- Use `staging-core` for broad Workflow Engine changes before production
  claims. If no live staging deploy exists, attach dry-run output and a
  time-boxed waiver.
- Use `production-smoke`, `pg-verify`, and `healthcheck` before normal
  production release.
- Use `specialist-qa` only when Shikadai requests it. `state:ready-for-test` is
  not a universal release gate.
