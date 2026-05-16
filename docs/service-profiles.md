# Konoha Service Profiles

Issue #761 defines named deployment profiles so the server does not treat every
agent, MCP pack, and watchdog as always-on.

The machine-readable source of truth is `docs/service-profiles.json`.
`scripts/healthcheck-system.py` and `scripts/agent-autostart.py` both read that
catalog through `scripts/service_profiles.py`.

Resource budgets for these profiles are defined separately in
`docs/resource-budgets.json` and explained in `docs/resource-budget-policy.md`.

## Profiles

| Profile | Purpose | Infra dependencies | Autostart agents | Enabled connectors | Enabled optional monitors |
| --- | --- | --- | --- | --- | --- |
| `prod-core` | Lean production always-on runtime: API, Redis/Postgres, Telegram ingestion, Naruto/Sasuke, bounded Akamaru/Kiba monitoring. | `postgresql.service` | `naruto`, `sasuke`, `kiba` | `telegram` | `akamaru`, `kiba` |
| `prod-full` | Production with the SDD development/review lane enabled. Specialist workers remain on demand. | `postgresql.service` | `naruto`, `sasuke`, `kiba`, `kakashi` | `telegram` | `akamaru`, `kiba`, `kakashi`, `shikadai` |
| `staging-core` | Staging API core without external Telegram connector or worker fleet unless explicitly enabled. | `postgresql.service` | none | none | `akamaru` |
| `qa-on-demand` | QA/test profile where QA workers and TestBench are started manually for bounded sessions. | `postgresql.service` | none | none | `akamaru` |

Use `KONOHA_SERVICE_PROFILE=<profile>` to select a profile. Default is
`prod-core`.

## Operational Semantics

- `prod-core` is the always-on baseline. Kakashi, Shikadai, Shino, Hinata, Guy,
  Ibiki, Jiraiya, Ino, Inojin, TestBench, and heavy MCP packs are optional.
- `agent-autostart.py` starts only `autostart_agents` from the selected profile.
  It does not scan every seeded agent with an `autostart` tag.
- Optional workers can be stopped without watchdogs or healthcheck immediately
  resurrecting/failing them unless the selected profile or explicit policy
  enables that worker.
- `agent-watchdog-lifecycle.service` may listen for on-demand agents, but it is
  a delivery adapter. It is not an autostart policy and must not resurrect
  optional workers just because they are offline.
- `infra_dependencies` lists required platform dependencies that the profile
  expects but does not classify as Konoha-owned runtime services. PostgreSQL is
  modeled there because deployments may provide it through a local
  `postgresql.service`, a container, or an external managed database.
- Heavy MCP/browser/Office/Miro/document packs remain outside always-on
  profiles. Use explicit TTL/debug profiles from
  `docs/mcp-optional-packs-policy.md`.

## Healthcheck Policy

Healthcheck loads the selected service profile first, then applies overrides in
this order:

1. `/opt/shared/konoha-health-policy.json`, when present.
2. `KONOHA_HEALTH_ENABLED_CONNECTORS` or `KONOHA_ENABLED_CONNECTORS`.
3. `KONOHA_HEALTH_ENABLED_OPTIONAL_MONITORS` or
   `KONOHA_ENABLED_OPTIONAL_MONITORS`.

Examples:

```bash
KONOHA_SERVICE_PROFILE=prod-core python3 scripts/healthcheck-system.py
KONOHA_SERVICE_PROFILE=staging-core python3 scripts/healthcheck-system.py
KONOHA_SERVICE_PROFILE=qa-on-demand python3 scripts/healthcheck-system.py
python3 scripts/healthcheck-system.py --policy-dry-run
```

An optional-disabled service that is absent is `OK`. A disabled service that is
still installed and active can still warn when it is in the wrong slice or
failed, because that is real runtime drift.

## Relationship To Systemd

This issue defines documented profiles rather than adding new `.target` units.
The committed `.service` and `.slice` units remain the enforcement surface for
budgeting and supervision. Profiles decide which of those units are expected for
a deployment mode. Infrastructure dependencies are documented separately from
`required_services` so the profile can express PostgreSQL without requiring it
to be supervised by the same systemd profile.
