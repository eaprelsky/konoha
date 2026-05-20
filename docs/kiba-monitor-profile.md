# Kiba Shared Monitor Profile

Issue #772 keeps Kiba as one shared monitor for production and staging instead
of spawning a second staging Kiba runtime. The machine-readable contract is
`docs/kiba-monitor-profile.json`.

## Targets

| Environment | Service profile | Konoha URL env | Remediation |
| --- | --- | --- | --- |
| `prod` | `prod-core` | `KONOHA_URL` | Enabled only when `KIBA_ACTION_TARGET_ENV=prod` |
| `staging` | `staging-core` | `KONOHA_STAGING_URL` | Disabled unless `KIBA_ACTION_TARGET_ENV=staging` |

Kiba keeps the `kiba-monitor-core` tool profile and the `konoha` MCP allowlist
for both targets. Staging is a monitor target, not a reason to start another
Kiba agent or another broad MCP pack.

`KONOHA_URL` remains the Konoha bus/control-plane URL for the single shared
Kiba runtime. Akamaru resolves the monitored `/health` and `/agents` URL from
the selected target's `konoha_url_env`; for example,
`KIBA_MONITOR_ENVIRONMENT=staging` checks `KONOHA_STAGING_URL`, not the
production bus URL.

## Environment Labels

All Kiba alert and healthcheck messages must carry `env=<environment>`:

```text
kiba:alert env=prod service=konoha.service status=failed
kiba:alert env=staging konoha=timeout
kiba:healthcheck env=prod
```

`scripts/akamaru.py` and `scripts/watchdog_base.py` add the label before sending
messages to Kiba. `scripts/healthcheck-system.py` prints its summary with the
selected monitor environment so copied summaries stay environment-scoped.

## Healthcheck Routing

Akamaru sends monitor output to the `ops` channel so healthcheck/audit history
is readable without waking every agent. Actionable incidents are routed to
`role:monitor` as `type=task` with `severity=incident`; Kiba receives these
through its normal watchdog path.

Routine healthcheck heartbeats use `type=status` and `severity=info`.
Known baseline conditions for intentionally stale/offline agents (`shino`,
`tsunade`, `mirai`) use `severity=baseline` and are archived to the ops channel
without monitor tmux delivery. Watchdog delivery still keeps default direct
messages actionable, but suppresses `status`, `event`, `result`, lifecycle,
ack, and baseline healthcheck records from agent tmux sessions.

## Action Guard

Deterministic Kiba recovery actions are admin actions. They require:

1. The incoming alert has an explicit `env=...` field.
2. `KIBA_ACTION_TARGET_ENV` is set.
3. Both values match.

If a staging alert reaches a Kiba watchdog configured with
`KIBA_ACTION_TARGET_ENV=prod`, Kiba sends an audit-only message and does not call
the lifecycle API or `systemctl` for production.
