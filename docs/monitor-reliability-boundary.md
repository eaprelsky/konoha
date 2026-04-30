# Monitor and reliability boundary

Akamaru/Kiba currently covers both deployment monitoring and product-visible reliability signals. This boundary keeps live behavior unchanged while separating operational runtime checks from workflow concepts operators can reason about.

Do not rename services, tmux sessions, watchdog units, Redis keys, or runtime ids as part of this boundary slice.

## Infra Monitor Runtime

These responsibilities remain infrastructure watchdog behavior:

- `akamaru.service` polling systemd, Redis, Konoha HTTP health, disk, memory, agent heartbeats, and tmux sessions.
- `agent-kiba.service` and `agent-watchdog-kiba.service` delivering Akamaru alerts to the optional system monitor runtime.
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

1. Add a `reliability-incident-triage` workflow skeleton for healthcheck failures and dead-letter streams.
2. Emit structured `reliability.signal` events from Akamaru/healthcheck without changing current alert delivery.
3. Add an operator inbox view for reliability cases separate from tmux/runtime debug logs.
4. Replace long-lived paused-service entries with expiring suppressions and review tasks.
5. Move service restart decisions beyond the safe allowlist into workflow approval.

## Runbook Rule

Use `scripts/healthcheck-system.py` for deployment readiness and raw runtime diagnostics. Use workflow cases for decisions, assignment, escalation, and post-incident learning.
