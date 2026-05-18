# Lean Konoha Baseline Gate

Issue #776 makes the lean runtime baseline a release prerequisite for broad
BPMS refactors, staging rollout, and any work that expands the always-on agent
or MCP surface.

## Gate Rule

Do not start a broad BPMS refactor rollout, staging deployment for #753, or
always-on worker/MCP expansion until one of these is true:

- the selected production profile is `prod-core` and the live inventory proves
  the lean baseline is active;
- the selected staging profile is `staging-core` and external connectors plus
  worker fleets remain disabled by default;
- Naruto records an explicit waiver with the reason, expected duration,
  rollback plan, and owner.

Routine bug fixes and bounded one-issue Developer -> Reviewer work may continue
under `prod-full` or an active SDD lane, but they must not be used as proof that
the production baseline is clean.

## Baseline Contract

The machine-readable deployment contract is split across these files:

| Contract | Source |
| --- | --- |
| Service profile and required/optional service policy | `docs/service-profiles.json` |
| Resource envelopes and scale-out policy | `docs/resource-budgets.json` |
| Canonical agent lifecycle and MCP allowlist | `docs/system-agent-roster.json` |
| Live measurement command | `scripts/resource-inventory.py --json --no-disk` |
| Healthcheck policy command | `scripts/healthcheck-system.py --policy-dry-run` |

The lean production baseline is `prod-core`: Konoha API, Redis/PostgreSQL,
Telegram ingestion, Naruto/Sasuke, Akamaru, and bounded Kiba monitoring.
Kakashi, Shikadai, Shino, Hinata, Guy, Ibiki, Jiraiya, TestBench, browser MCP,
Office/Miro/spreadsheet MCP, memory, retired MemPalace, calendar, audio, and other broad
diagnostic packs are optional/on-demand.

## Measurement

The table records the measured source/runtime evidence that currently gates
BPMS rollout.

| Measurement | Process count | RSS KiB | Status |
| --- | ---: | ---: | --- |
| Kiba broad MCP before #762 (`docs/mcp-resource-inventory.md`) | 29 | 1,433,224 | before baseline |
| Expected Kiba `kiba-monitor-core` default after restart/regeneration | 1 | about 86,900 | target |
| Optional Office/Miro/browser gated packs before #785 | 9 | 378,000 | before baseline |
| Expected Office/Miro/browser gated packs after restart/regeneration | 0 | 0 | target |
| Live inventory on 2026-05-18 08:24 MSK, `managed_agent` group | 26 | 3,102,400 | active SDD lane, not clean `prod-core` |
| Live inventory on 2026-05-18 08:24 MSK, `mcp_server` group | 67 | 3,598,664 | critical; stale broad MCP still running |
| Live inventory on 2026-05-18 08:24 MSK, `testbench_browser` group | 8 | 505,232 | on-demand browser pool active |
| Live inventory on 2026-05-18 08:24 MSK, `konoha.slice` | 0 slice processes | 2,565,500 | inside parent cap, but not a clean baseline proof |

The expected source-level reduction is material: Kiba's default MCP surface drops
from 29 child processes / 1,433,224 KiB to one Konoha MCP child at about
86,900 KiB, and optional Office/Miro/browser packs drop from 9 processes /
378,000 KiB to zero by default.

Current live production is not accepted as a clean baseline snapshot because
the SDD lane is active and the process table still shows stale broad MCP
descendants under Kiba. This is the documented exception required by #776:
until Kiba and any affected agent workdirs are restarted/regenerated under their
approved profiles and the live inventory is re-run, broad BPMS/staging rollout
remains blocked.

## Required Preflight For BPMS Or Staging Rollout

Before starting #753 or any broad BPMS refactor, run:

```bash
KONOHA_SERVICE_PROFILE=prod-core python3 scripts/healthcheck-system.py --policy-dry-run
KONOHA_SERVICE_PROFILE=prod-core python3 scripts/healthcheck-system.py
python3 scripts/resource-inventory.py --json --no-disk
```

The rollout may proceed only when:

- `prod-core` reports Telegram connector enabled and optional monitors limited
  to Akamaru/Kiba unless a waiver enables more;
- Kakashi/Shikadai/Shino/Hinata/Guy/Ibiki/TestBench are absent or explicitly
  documented as temporary on-demand work;
- Kiba has no non-monitoring MCP descendants;
- Office/Miro/spreadsheet/browser/memory/retired MemPalace/calendar/audio packs are not
  present in the always-on process tree;
- `resource_inventory.budget_pressure` has no unexplained critical rows for
  Konoha-owned services or slices.

## Staging Rule For #753

The staging plan must start from `staging-core`, not from the current full
production profile:

- no production Telegram connector by default;
- no Naruto/Sasuke/Kiba/Kakashi/Shikadai/QA worker fleet by default;
- TestBench is on demand with pool size 1;
- Redis/PostgreSQL are isolated from production state;
- staging healthcheck uses `KONOHA_SERVICE_PROFILE=staging-core`;
- any connector or worker activation is time-boxed and recorded in the staging
  runbook.

## Waiver Format

A waiver must include:

```text
Lean baseline waiver for #776
Scope:
Reason:
Owner:
Expires:
Rollback:
Measured risk:
```

Waivers are exceptional. They do not change `prod-core` or `staging-core`
defaults.
