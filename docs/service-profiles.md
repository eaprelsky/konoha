# Konoha Service Profiles

Issue #761 defines named deployment profiles so the server does not treat every
agent, MCP pack, and watchdog as always-on.

The machine-readable source of truth is `docs/service-profiles.json`.
`scripts/healthcheck-system.py`, `scripts/agent-autostart.py`, and feature flag
resolution read that catalog through `scripts/service_profiles.py`.

Resource budgets for these profiles are defined separately in
`docs/resource-budgets.json` and explained in `docs/resource-budget-policy.md`.
The rollout gate that makes the lean baseline a prerequisite for broad BPMS and
staging work is `docs/lean-baseline-gate.md`.

## Profiles

| Profile | Purpose | Infra dependencies | Autostart agents | Enabled connectors | Enabled optional monitors | Enabled feature flags |
| --- | --- | --- | --- | --- | --- | --- |
| `prod-core` | Lean production always-on runtime: API, Redis/Postgres, Telegram ingestion, Naruto/Sasuke, bounded Akamaru/Kiba monitoring. | `postgresql.service` | `naruto`, `sasuke`, `kiba` | `telegram` | `akamaru`, `kiba` | none |
| `prod-full` | Production with SDD GitHub/review watchdogs enabled while Developer/Test runtimes remain on demand. | `postgresql.service` | `naruto`, `sasuke`, `kiba` | `telegram` | `akamaru`, `kiba`, `kakashi`, `shikadai` | none |
| `staging-core` | Staging API core without external Telegram connector or worker fleet unless explicitly enabled. | `postgresql.service` | none | none | `akamaru` | none |
| `qa-on-demand` | QA/test profile where QA workers and TestBench are started manually for bounded sessions. | `postgresql.service` | none | none | `akamaru` | `testbench` |

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
- SDD dev/test workers are additionally governed by
  `docs/sdd-worker-pool.json` and `scripts/sdd-worker-pool.py`: at most two
  active SDD workers, at most one specialist, and an 1800 second idle mission
  TTL. The pool starts and stops workers through the lifecycle API and records
  bus handoffs.
- Kiba uses `docs/kiba-monitor-profile.json` as a single shared monitor profile
  for `prod` and `staging`. Alerts and healthcheck summaries carry
  `env=<target>`, and remediation actions require an explicit matching
  `KIBA_ACTION_TARGET_ENV`.
- `disabled_lifecycle_agents` is the explicit profile state for optional
  workers that must not be restarted by systemd wrappers or the generic
  lifecycle watchdog. `prod-core` disables Kakashi and QA specialists by
  default; `prod-full` enables Kakashi's GitHub watchdog but still keeps the
  Codex runtime stopped until a delegated issue arrives; `qa-on-demand` enables
  Shino/Hinata/Guy/Ibiki delivery for explicit QA assignments.
- `agent-watchdog-lifecycle.service` may listen for on-demand agents, but it is
  a delivery adapter. It is not an autostart policy and must not resurrect
  optional workers just because they are offline.
- `infra_dependencies` lists required platform dependencies that the profile
  expects but does not classify as Konoha-owned runtime services. PostgreSQL is
  modeled there because deployments may provide it through a local
  `postgresql.service`, a container, or an external managed database.
- Heavy MCP/browser/Office/Miro/document packs remain outside always-on
  profiles. Use explicit TTL/debug profiles from
  `docs/browser-testing-policy.md` and `docs/mcp-optional-packs-policy.md`, and
  enable the matching feature flag with a recorded owner/reason.
- TestBench is optional in every core profile. `qa-on-demand` enables the
  `testbench` feature for bounded browser sessions; `prod-core` and
  `staging-core` keep browser routes, UI surfaces, and the Chromium service off
  unless an operator explicitly enables them for a golden-path run.
- Experimental product surfaces are default-off in `prod-core` and
  `staging-core`. The machine-readable feature catalog is
  `docs/feature-flags.json`; route/API/UI/MCP gates read the selected service
  profile and `KONOHA_FEATURE_*` overrides.
- Broad BPMS refactors and the staging rollout in #753 must start from this
  profile contract. They are blocked by `docs/lean-baseline-gate.md` until
  `prod-core` is live-clean or a time-boxed waiver is recorded.

## Healthcheck Policy

Healthcheck loads the selected service profile first, then applies overrides in
this order:

1. `/opt/shared/konoha-health-policy.json`, when present.
2. `KONOHA_HEALTH_ENABLED_CONNECTORS` or `KONOHA_ENABLED_CONNECTORS`.
3. `KONOHA_HEALTH_ENABLED_OPTIONAL_MONITORS` or
   `KONOHA_ENABLED_OPTIONAL_MONITORS`.

Feature flags are reported separately. Disabled experiments are `OK` when they
match the selected profile; enabled experiments should include `enabled_by` and
`reason` through `/opt/shared/konoha-feature-flags.json` or the matching
environment override.

Examples:

```bash
KONOHA_SERVICE_PROFILE=prod-core python3 scripts/healthcheck-system.py
KONOHA_SERVICE_PROFILE=staging-core python3 scripts/healthcheck-system.py
KONOHA_SERVICE_PROFILE=qa-on-demand python3 scripts/healthcheck-system.py
python3 scripts/healthcheck-system.py --policy-dry-run
```

To override the disabled lifecycle guard for a bounded recovery or manual
mission, set `KONOHA_ENABLE_DISABLED_LIFECYCLE_AGENTS=<id>` or `all` in the
service environment and restart the relevant wrapper/watchdog.

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
