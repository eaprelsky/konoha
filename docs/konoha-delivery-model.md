# Konoha Delivery Model For Architecture Work

Issue #756 records the recommended delivery model for the #672 BPMS architecture
program. The machine-readable contract is `docs/konoha-delivery-model.json`.

The decision is conservative: keep the default path as Developer Kakashi ->
Reviewer Shikadai, and use Shino, Hinata, Guy, or Ibiki only when a checklist or
reviewer decision explicitly calls for specialist escalation.

Canonical default path: Developer Kakashi -> Reviewer Shikadai.

## Recommendation

Architecture-grade work should use a small, blocking review path:

```text
Naruto dispatches one issue
  -> Kakashi implements one scoped fix
  -> Shikadai reviews architecture, checks, rollback, and evidence
  -> accepted/closed or blocked back to Kakashi
```

More agents are not a quality signal by themselves. Quality comes from stable
contracts, focused tests, staging evidence where applicable, Action Spine/security
checks, rollback notes, and reviewer findings that can block closure.

## Role Responsibilities

| Role | Responsibility | Default use | Quality signal |
| --- | --- | --- | --- |
| Naruto | Coordination and issue sequencing | Dispatch one ready issue; record closure and next assignment; coordinate owner approval for releases | Clear issue dispatch, Konoha bus audit, owner/operator decision capture |
| Kakashi | Developer implementation | Implement exactly one delegated issue with `state:ready-for-dev` or `state:in-progress` + `agent:kakashi` | Focused commit, checks, parent receipt, ready-for-review handoff |
| Shikadai | Reviewer and architecture gate | Review implementation, gates, rollback, docs, and architectural integrity before closure | Acceptance, blocking finding, or changes requested with evidence |
| Shino | Test-plan escalation | Only when Shikadai requests `state:ready-for-test` for QA-heavy, release, or regression scope | Focused QA plan, pass/fail report, residual risk |
| Hinata | Bounded browser/TestBench execution | Only after reviewer-approved browser/TestBench plan exists | Playwright/TestBench artifacts when requested |
| Kiba/Akamaru | Monitoring and severity-aware delivery | Health, resource, connector, and environment-labeled monitor evidence | Actionable incident or archived baseline warning |
| Ibiki | Security and audit escalation | Only for security-sensitive review or audit boundary questions requested by Shikadai/Naruto | Security/audit finding, risk wording, or approval note |

Guy remains a mechanical/docs helper only when explicitly requested. He is not a
default architecture stage.

## Human Decisions

These decisions must remain with the owner/operator or reviewer, not an
automated agent:

- normal production release approval;
- emergency bypass risk acceptance;
- destructive data cleanup approval;
- external connector resend/user-impact acceptance;
- production service rollback command approval;
- unpausing paused P0 work such as #812.

Automate the routine checks instead of adding serial agent gates:

```bash
scripts/preflight-portable.sh
scripts/preflight.sh
bun run scripts/action-surface-report.ts --check
python3 scripts/check-route-auth-policy.py
bun run scripts/pg-verify.ts
scripts/staging-smoke.sh --dry-run
```

## Minimum Gates For P0/P1 Workflow Engine Changes

Required:

- Kakashi implements the issue and commits only the scoped change.
- Shikadai reviews before closure and may block implementation or release.
- Focused tests cover success and failure behavior where applicable.
- M1 isolation evidence is attached when storage, staging, factories, or tests
  are touched.
- Action Spine/security checks run for user-visible mutations.
- The #812 terminal-case rule is checked when dispatch, waits, subscriptions,
  or runtime effects are touched.
- Rollback/recovery references `docs/workflow-runtime-rollback-recovery.md`.
- Parent #672, #686, or the child issue receives a receipt when the work feeds a
  program/release gate.

Optional only when requested:

- Shino test-plan escalation.
- Hinata browser/TestBench run.
- Ibiki security/audit review.

## GitHub Labels And States

| Transition | Labels |
| --- | --- |
| Developer intake | `state:ready-for-dev` + `agent:kakashi` |
| Developer rework | `state:in-progress` + `agent:kakashi` |
| Review handoff | `state:ready-for-review` + `agent:shikadai` |
| Review blocked | `state:blocked` + `agent:kakashi` |
| Optional specialist QA | `state:ready-for-test` + `agent:shino` |
| Done | `state:done` |

Legacy labels such as `needs-testing`, `awaiting-test`, `P0`, and
`P0: critical` are not gates. Canonical labels from `docs/label-taxonomy.md`
drive release decisions.

## Konoha Bus Handoff Format

Use short, auditable messages:

```text
Taking issue #<n>: <title>
Ready for review: issue #<n> — commit <hash>. <summary>
Changes requested for issue #<n>: <finding>. Follow-up required.
Issue #<n> accepted and closed at <hash>. Taking/awaiting next dispatch.
Reviewer-requested QA for issue #<n>: scope=<test-plan|browser|security> commands=<commands> artifacts=<artifacts>
Duplicate delivery for issue #<n> ignored; actual state is <state/labels>.
```

Do not notify Shino, Hinata, or Guy by default. Shikadai must request the
specialist branch, or Kakashi must explicitly delegate a mechanical/docs task to
Guy when the issue scope permits it.

## Staging QA Signoff

Use staging QA when the change affects broad Workflow Engine runtime behavior,
deploy/subscriptions, connector/outbox effects, or production release claims.

Default evidence:

```bash
scripts/staging-smoke.sh --dry-run
```

Live staging evidence:

```bash
set -a
source /opt/shared/.agent-env.staging
set +a
scripts/staging-smoke.sh --live
```

The staging lane must preserve #753 separation: `staging-core`, Redis DB `2`,
`konoha_staging`, staging agent ids, no production workdirs, and no production
connectors unless a time-boxed waiver is accepted. A staging waiver must not
weaken `prod-core`.

## Rollback And Redispatch

- If Shikadai blocks review, the issue returns to `state:blocked` +
  `agent:kakashi`. Kakashi pushes a follow-up commit and resubmits.
- Duplicate watchdog deliveries are stale if GitHub already shows
  `state:ready-for-review`, `state:done`, or a different assigned role.
- Dirty worktree tails are not a stop reason. Unrelated files stay unstaged; the
  commit includes only the active issue scope.
- Runtime/data rollback uses `docs/workflow-runtime-rollback-recovery.md`.
- Specialist worker rollback uses:

```bash
python3 scripts/sdd-worker-pool.py rollback --reason <reason>
```

## Related Contracts

- `docs/sdd-worker-pool.md` for bounded optional specialist missions.
- `docs/staging-environment.md` for staging-core isolation.
- `docs/release-policy.md` for release gates and waiver wording.
- `docs/workflow-engine-preflight-tiers.md` for tier selection.
- `docs/workflow-runtime-rollback-recovery.md` for runtime rollback limits.
- `docs/workflow-constructor-runtime-release-checklist.md` for PR/review
  evidence.
- `docs/github-sdd-connector.md` for GitHub event and label delivery.
