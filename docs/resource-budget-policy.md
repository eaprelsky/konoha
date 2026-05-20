# Konoha Resource Budget Policy

Issue #757 defines the budget contract that sits above the service-profile
startup contract from #761 and the live inventory report from #760.

Machine-readable source of truth: `docs/resource-budgets.json`.

Runtime consumers:

- `scripts/resource-inventory.py` reads expected service budgets and disk cache
  budgets from the contract.
- `scripts/healthcheck-system.py` reads slice budget policy from the contract
  and reports group/service pressure through `resource_inventory.budget_pressure`.
- `konoha-testbench` enforces the configured browser pool cap at runtime.
- `src/agent/systemd-slices.ts` starts managed optional agents in bounded
  transient scopes.
- `scripts/mcp-idle-wrapper.ts` starts on-demand MCP packs in bounded
  transient scopes when systemd is available.
- `scripts/bpms-load-regression.ts` validates BPMS load/soak observations
  against profile thresholds that must stay within these resource budgets.

## Profile Budgets

| Budget profile | Service profile | Use | Memory max | CPU quota | Disk budget | TestBench |
| --- | --- | --- | --- | --- | --- | --- |
| `prod-core` | `prod-core` | Production smoke and lean always-on runtime | 6500 MiB | 600% | 35 GiB | disabled by default |
| `prod-full` | `prod-full` | Production with SDD developer/reviewer lane | 6500 MiB | 600% | 40 GiB | on demand, pool 1-2 |
| `staging-core` | `staging-core` | Golden-path staging tests without prod connectors/fleet | 2600 MiB | 250% | 12 GiB | disabled by default |
| `qa-on-demand` | `qa-on-demand` | Manual QA/TestBench sessions | 3600 MiB | 350% | 20 GiB | manual, pool 1-2 |
| `ci-test` | `qa-on-demand` | CI/unit/integration execution | 2200 MiB | 250% | 10 GiB | disabled |

Development work should use `qa-on-demand` unless the task explicitly needs a
production connector. QA browser work should use `qa-on-demand` plus TestBench.
Production smoke should use `prod-core`; `prod-full` is only for deployments
where the SDD lane is intentionally active.

## Staging And Test Defaults

`staging-core` starts only the API/runtime, Redis/PostgreSQL dependencies, and
Akamaru health monitoring. Telegram ingestion, Naruto/Sasuke, Kiba, Kakashi,
Shikadai, lifecycle-managed QA workers, TestBench, browser MCP, and heavy
corporate MCP packs stay opt-in.

`ci-test` is not a long-running systemd target. It is the budget envelope for
test commands and release gates: no production Telegram connector, no managed
agent fleet, no persistent TestBench pool, and no Office/Miro/browser MCP pack.

## Optional Agents And MCP Packs

Optional interactive agents are always below production chat/core priority:

| Runtime | Slice | Memory max | CPU quota | Applied by |
| --- | --- | --- | --- | --- |
| Kiba monitor | `konoha-agents.slice` | 900M | 150% | `systemd/agent-kiba.service` and `src/agent/systemd-slices.ts` |
| SDD/QA agents | `konoha-qa.slice` | 900M | 150% | `systemd/agent-managed@.service`, `systemd/agent-kakashi.service`, and transient agent scopes |
| Heavy on-demand MCP packs | `konoha-qa.slice` | 384M | 50% | `scripts/mcp-idle-wrapper.ts` via `systemd-run --scope` |
| Low-cost on-demand MCP packs | `konoha-qa.slice` | 256M | 25% | `scripts/mcp-idle-wrapper.ts` via `systemd-run --scope` |

The on-demand MCP wrapper names scopes as `konoha-mcp-<pack>.scope`; it can be
disabled for rollback or non-systemd development with
`KONOHA_MCP_SYSTEMD_SCOPE=0`. Persistent startup still defers rare/heavy packs,
so these limits apply only when a task/session explicitly requests a pack.

## Staging Drop-In

`staging-core` may install
`systemd/dropins/staging-core-konoha.conf` as
`/etc/systemd/system/konoha.service.d/staging-core-bounds.conf`. That drop-in
keeps the staging API under `MemoryMax=900M`, `CPUQuota=150%`, and
`TasksMax=3072` so browser, MCP, or optional worker tests cannot consume the
full production core envelope.

## TestBench Bounds

`konoha-testbench.service` is an on-demand service capped in
`konoha-qa.slice`:

- `MemoryMax=768M`
- `CPUQuota=100%`
- `TasksMax=1024`
- `TESTBENCH_MODE=on-demand`
- `TESTBENCH_POOL_SIZE=1`
- `TESTBENCH_MAX_POOL_SIZE=2`
- `TESTBENCH_MAX_CONCURRENT_JOBS=2`
- `TESTBENCH_SESSION_TTL_MS=300000`

The service code clamps requested pool size to `TESTBENCH_MAX_POOL_SIZE`, so an
accidental environment override cannot create an unbounded Chromium pool. Core
production and staging profiles keep TestBench disabled until `testbench` is
explicitly enabled for an on-demand QA or golden-path browser run. Healthcheck
reports the live pool limits and warns when an idle browser pool remains active
while TestBench or `testbench_browser` memory pressure is warning/critical.

## Redis And PostgreSQL

Redis and PostgreSQL are `infra_dependencies` in `docs/service-profiles.json`.
They may be local systemd services, containers, or managed external services.
When they are local, use the budget contract recommendations:

| Service | Slice | Memory max | CPU quota | Retention |
| --- | --- | --- | --- | --- |
| `redis-server.service` | `konoha-infra.slice` | 768M | 100% | AOF `everysec`; noeviction unless explicitly changed |
| `postgresql.service` | `konoha-infra.slice` | 1200M | 150% | At least 7 daily logical backups; prune shadow bloat through retention reports |

Backup/restore readiness is governed by `docs/data-store-drill.json` and
`docs/data-store-disaster-recovery.md`. Redis and PostgreSQL restore drills must
run in `staging-core`; production restores require platform owner approval.

## Capacity Report

Use the live inventory for incident-safe reporting:

```bash
python3 scripts/resource-inventory.py
python3 scripts/resource-inventory.py --json --no-disk
python3 scripts/healthcheck-system.py | rg 'resource_inventory|slice.|service_slice.'
```

The text report includes process groups, top RSS processes, service budgets,
OOM/restart state, memory-limit hits, and cache/artifact disk pressure. JSON
output omits raw process args and keeps only redacted args.

## BPMS Load Regression

`docs/bpms-load-profiles.json` defines the #788 load, release-gate staging, and
eight-hour staging soak profiles. The profiles reuse `ci-test` and
`staging-core`; no separate resource budget contract is allowed for BPMS load
tests. Generate `bpms-load-regression-report.json` with
`scripts/bpms-load-regression.ts` and attach it to the release gate before broad
Workflow Engine changes.

## Scale-Out Policy

Scale out to a second VM when any of these conditions remains true after
optional workers and stale MCP configs are stopped:

- `prod-core` hits critical memory pressure twice in 24 hours.
- TestBench needs `pool_size > 2` or sustained QA runs overlap production smoke.
- Redis and PostgreSQL together exceed 75% of `konoha-infra.slice`.
- Disk remains above 85% after retention cleanup.
- MCP server RSS remains critical after optional pack gates are in effect.

Move first: TestBench, optional SDD/QA agents, and heavy MCP/debug packs. Keep
`konoha.service`, Redis/PostgreSQL, and Telegram ingress together until a
separate data-plane migration is designed.

## Shared Mail Infrastructure

`docs/mail-integration-profile.json` defines the minimal Konoha mail runtime and
the shared mail host boundary. Mail is product-critical shared infrastructure,
not optional Konoha runtime bloat: Lean Konoha cleanup may remove Office,
document, spreadsheet, Miro, and browser MCP packs, but must not remove the mail
stack or require those packs for mail delivery.
