# Konoha Release Policy

This document is the source of truth for Konoha release decisions. It connects
the canonical label taxonomy, staging assumptions, preflight scripts, reviewer
handoff, versioning, rollback, and audit evidence into one policy.

Related gates and roadmap issues:

- #686 remains the Workflow Engine child release gate/runbook. It must inherit
  this policy instead of replacing it.
- #795 log retention and disk hygiene are release-readiness checks because
  unbounded logs can block agents and systemd services.
- #793 defines canonical labels used by this policy.
- #794 defines the issue-delivery/bootstrap route that feeds reviewer evidence.
- #753 defines the `staging-core` environment contract used by release staging.
- #749 defines the Workflow Engine preflight tier contract in
  `docs/workflow-engine-preflight-tiers.md`.
- #682, #733, #734, #735, and #736 are the M1 storage isolation/preflight
  foundation required before broad Workflow Engine release claims.

## Release Types

| Type | Use | Required gates | Approval |
| --- | --- | --- | --- |
| Normal release | Planned product or runtime release from `main` | CI portable preflight, reviewer acceptance, production preflight, release checklist | Naruto requests owner approval; Kakashi executes after approval |
| Hotfix | Urgent fix for production incident, `priority:p0`, `risk:critical`, or confirmed regression | Focused tests, reviewer acceptance when available, production health smoke before and after deploy | Naruto coordinates; owner approval required unless already covered by incident command |
| Emergency bypass | Production impact is active and waiting for full gates is riskier than deploying | Minimal focused test/smoke, explicit risk acceptance, rollback note | Owner/operator must write explicit risk acceptance before deploy |
| Infra-only change | systemd, scripts, resource budgets, deploy profiles, monitor policy | Relevant Python/Bun contract tests, `bash -n`, production healthcheck or policy dry-run | Shikadai review plus Naruto/owner approval when production services change |
| Docs-only change | Documentation, runbooks, architecture policy with no runtime effect | Diff review, policy/contract test when the doc is a source of truth | Shikadai review; no production deploy gate unless release notes/tag are created |

`needs-testing` is a retired label and is not a release gate. `state:ready-for-test`
is an optional specialist QA branch requested by Shikadai for QA-heavy,
release, or regression scope. Ordinary Developer -> Reviewer fixes do not wait
for Shino/Hinata unless Shikadai asks for that branch.

## Environments

| Environment | Purpose | Gate |
| --- | --- | --- |
| Local / CI | Portable verification without production secrets, systemd, Telegram, or live tmux sessions | `scripts/preflight-portable.sh` |
| Staging | Workflow Engine and QA validation without production Redis DB `0`, PostgreSQL `public`, Telegram streams, or production workdirs | `docs/staging-environment.md`, `scripts/staging-smoke.sh --dry-run`, and live staging smoke when a staging deploy exists |
| Production server | Release candidate validation against live services, health, Telegram connector, and PostgreSQL shadow state | `scripts/preflight.sh` and `scripts/pre-release-gate.py` |

Staging must use `KONOHA_SERVICE_PROFILE=staging-core`, `KONOHA_PORT=3210`,
Redis DB `2`, PostgreSQL `konoha_staging`, disabled external connectors by
default, and the guardrails in `docs/staging-environment.json`. A staging waiver
does not weaken `prod-core`.

## Gates

### CI Portable Preflight

Run for all normal releases and for any change touching runtime, storage,
frontend build, Action Spine, staging policy, or tests:

```bash
scripts/preflight-portable.sh
```

This includes the M1 test-storage contracts:

- `tests/test-storage-guardrails.test.ts`
- `tests/redis-test-isolation-contract.test.ts`
- `tests/pg-test-isolation-contract.test.ts`
- `tests/test-factory-namespace.test.ts`
- `tests/staging-environment.test.ts`

### Production Preflight

Run before normal production release and after changing lifecycle, watchdog,
storage, messenger, resource, healthcheck, or deployment code:

```bash
scripts/preflight.sh
```

Production preflight adds live system health, Telegram smoke, PostgreSQL shadow
verification, lifecycle/watchdog checks, resource policy checks, data-store
drill contracts, staging smoke dry-run, and BPMS load-release report generation.

### Pre-Release Gate

`scripts/pre-release-gate.py` summarizes release blockers and warnings in policy
terms. It must use canonical labels from `docs/label-taxonomy.md`, especially
`priority:p0`, `risk:critical`, and `risk:regression`. It must not depend on
legacy labels such as `P0`, `P0: critical`, `awaiting-test`, or `needs-testing`.

### Optional Specialist Gates

Shikadai may request `state:ready-for-test` + `agent:shino` or `agent:hinata`
for release/regression-heavy work. That branch must report exact commands,
artifacts, and residual risk back to the issue before release approval.

Security-sensitive workflow changes must satisfy
`docs/workflow-security-boundary.md`, including Action Spine surface and route
authorization checks.

## Blockers And Warnings

Release blockers:

- Open `priority:p0` issue unless the release is the fix for that issue.
- Open `risk:critical` or `risk:regression` issue without an accepted waiver.
- Dirty worktree or unpushed release commit.
- Failed CI portable preflight.
- Failed production preflight for normal release.
- Reviewer has not accepted the issue/commit being released.
- `scripts/pg-verify.ts` reports `onlyInRedis` records.
- Runtime health failure for required `prod-core` services.
- Redis DB `0`, PostgreSQL `public`, or production connector contamination in
  tests/staging.
- Log/disk/resource pressure that can block agent startup or healthcheck.
- Missing changelog/version/tag/GitHub release evidence for a versioned release.

Warnings requiring release-note acknowledgement:

- PostgreSQL `onlyInPG` bloat when `onlyInRedis=0`.
- Optional worker, TestBench, or external connector disabled by profile as
  intended.
- Known infra warnings already recorded in the release issue.
- Docs-only changes that do not need production preflight.

Emergency bypass can override blockers only when the owner/operator writes:

```text
Emergency release bypass accepted for <commit/tag>.
Known skipped gates: <list>.
Risk accepted: <production/user/data impact>.
Rollback owner and command: <person/agent + command>.
Expires: <date/time>.
```

## Versioning And Release Artifacts

Versioned releases must update:

- `package.json` version.
- `CHANGELOG.md` top section for that version.
- Git tag `vX.Y.Z`.
- GitHub release notes with commit hash, issue list, gates run, waivers, and
  rollback notes.

Docs-only and infra-only changes may be merged without bumping `package.json`
when no versioned release is created. They still need reviewer acceptance and
issue audit trail.

## Rollback

Code rollback:

```bash
git revert <bad_commit>
git push origin main
```

Frontend rollback is the same code rollback plus rebuilding/redeploying the
frontend artifact if the deployed UI is separate from the Bun service.

Agent runtime rollback:

- restore prior service/profile environment;
- restart only the affected service or agent wrapper;
- verify `scripts/healthcheck-system.py` and Konoha bus registration;
- for optional agents, prefer lifecycle API stop/start over manual tmux surgery.

Workflow/runtime data rollback limits:

- Redis is still the active Workflow Engine store; PostgreSQL is shadow/durable
  evidence unless `PG_READ=true` has a separate accepted cutover.
- Reverting code does not revert Redis streams, cases, work items, reminders,
  subscriptions, or external messages already sent.
- Data rollback requires an explicit incident/audit issue naming affected
  workflows, cases, Redis keys, PostgreSQL tables, and operator command.
- `PG_READ=true` remains gated by the persistence roadmap and `pg-verify`
  evidence; bloat-only `onlyInPG` is retention debt, not a data-loss rollback.

## Ownership

| Role | Release responsibility |
| --- | --- |
| Owner/operator | Approves normal releases and accepts emergency bypass risk |
| Naruto | Coordinates release request, confirms issue state/evidence, asks owner approval, records bus audit |
| Kakashi | Executes release commands only after approval; version/tag/GitHub release; reports result |
| Shikadai | Reviews implementation, gates, waiver wording, and rollback evidence before closure/release |
| Shino/Hinata | Optional specialist QA only when Shikadai requests it |

## Audit Trail

Every release request or bypass must record:

- issue number(s) and commit hash;
- release type;
- gates run and pass/fail summary;
- skipped gates and waiver text;
- staging evidence if Workflow Engine/runtime behavior changed;
- rollback command and rollback limit note;
- Konoha bus message to Naruto/Shikadai with the same summary;
- GitHub release notes for versioned releases.

## Concise Checklist

1. Confirm the issue is accepted by Shikadai or explicitly covered by an
   emergency bypass.
2. Confirm canonical labels: no legacy `needs-testing`, `awaiting-test`, `P0`,
   or `P0: critical` route is part of the release decision.
3. Run `scripts/preflight-portable.sh` or cite the green CI run.
4. Run `scripts/preflight.sh` for normal production release, or document why the
   release type does not require it.
5. For Workflow Engine/runtime changes, attach staging-core evidence from #753
   and the relevant M1 isolation/preflight tier from
   `docs/workflow-engine-preflight-tiers.md`.
6. Run `python3 scripts/pre-release-gate.py` and resolve blockers.
7. Update version/changelog/tag/GitHub release for versioned releases.
8. Record rollback command and data rollback limits.
9. Naruto asks owner approval; Kakashi executes only after approval.
10. Report final status to Konoha bus and the release/issue record.
