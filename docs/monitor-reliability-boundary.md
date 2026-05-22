# Monitor and reliability boundary

Akamaru/Kiba currently covers both deployment monitoring and product-visible reliability signals. This boundary keeps live behavior unchanged while separating operational runtime checks from workflow concepts operators can reason about.

Do not rename services, tmux sessions, watchdog units, Redis keys, or runtime ids as part of this boundary slice.

## Infra Monitor Runtime

These responsibilities remain infrastructure watchdog behavior:

- `akamaru.service` polling systemd, Redis, Konoha HTTP health, disk, memory, agent heartbeats, and tmux sessions.
- Dedicated default-monitored agent units from `docs/system-agent-roster.md`,
  including Kiba, Kakashi, and Shikadai watchdog surfaces.
- `scripts/healthcheck-system.py` checking production readiness before delegation or incident work.
- paused/offline suppression files under `/opt/shared/kiba/`.
- safe auto-remediation for explicitly allowlisted infrastructure services.

Infra monitor output may use runtime ids because it is debugging deployment state.

## Workflow-Visible Reliability

These belong in explicit workflows, roles, documents, or case events:

- Review a stuck work item and decide whether to re-dispatch, cancel, or escalate.
- Triage repeated stream lag, dead-letter, or delivery failures into an incident case.
- Confirm that a paused service is intentionally parked before suppressing alerts.
- Review failed checks before a high-risk deployment or long-running delegation.
- Produce a post-incident summary with owner, root cause, and follow-up actions.

Workflow-visible reliability should use business roles such as `reliability_operator`, `incident_owner`, `deployment_reviewer`, and `connector_owner`, not runtime ids like `kiba` or `akamaru`.

The first workflow-visible scenario is `workflows/reliability/incident-triage.json`.
It starts from a `reliability.signal` system event and makes diagnosis, recovery
approval, suppression review, and post-incident summary visible as eEPC
functions with business roles and instruction documents.

## Boundary Table

| Signal or action | Stays infra monitor | Becomes workflow-visible |
| --- | --- | --- |
| `systemctl --failed` probe | Collect raw service state | Create/route incident when policy threshold is crossed |
| tmux idle/stuck prompt probe | Detect runtime session state | Ask responsible role to recover stuck work item |
| Redis stream lag/dead-letter probe | Measure queue health | Open connector reliability case |
| heartbeat stale alert | Detect runtime liveness | Escalate assignment or worker capacity issue |
| paused-services suppression | Avoid expected false positives | Require review/documented reason for long suppression |
| auto restart allowlist | Restart known safe infra services | Require human approval for non-allowlisted recovery |

## Follow-Up Issues

1. Emit structured `reliability.signal` events from Akamaru/healthcheck without changing current alert delivery.
2. Bind healthcheck failures and dead-letter streams to `reliability-incident-triage` cases.
3. Add an operator inbox view for reliability cases separate from tmux/runtime debug logs.
4. Replace long-lived paused-service entries with expiring suppressions and review tasks.
5. Move service restart decisions beyond the safe allowlist into workflow approval.

## Runbook Rule

Use `scripts/healthcheck-system.py` for deployment readiness and raw runtime diagnostics. Use workflow cases for decisions, assignment, escalation, and post-incident learning.

## Operational Alert Contract

`GET /operational-alerts` is the stable runtime alert surface for stuck cases
and failed runtime effects. It returns deterministic `alert_id`/`dedupe_key`
values, severity, case/effect correlation, evidence, and recovery action hints.
The endpoint is admin-only and does not mutate runtime state.

`scripts/healthcheck-system.py` reads this endpoint and emits
`runtime.operational_alerts`. Any non-empty alert set is a `WARN` with the first
alert id, kind, severity, case id, and effect id in the detail line so Akamaru's
existing severity-aware routing can wake the monitor role without creating a
new alert transport. Operators should inspect the correlated case/effect and
use the #720/#731 recovery APIs or Action Spine case actions; alerts are
idempotent observations, not recovery decisions.
