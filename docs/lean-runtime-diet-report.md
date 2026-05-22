# Lean Konoha Runtime Diet Closure Report

Issue #759 is the P0 epic for reducing always-on runtime and resource pressure
without weakening production chat, orchestration, mail, or recovery surfaces.
The machine-readable closure report is `docs/lean-runtime-diet-report.json`.

## Closure Scope

The reviewed child set is complete:

| Workstream | Issues | Result |
| --- | --- | --- |
| MCP cost, allowlists, lazy packs, pinned installs, duplicate connector removal, Sasuke Yonote read scope | #766, #767, #782, #783, #775 | Always-on MCP defaults are role-scoped; heavy/browser/Office/broad packs are task/session on-demand; connector MCPs stay with owners. |
| Optional worker and browser lifecycle | #765, #758, #770, #791 | Kakashi/Shino/QA workers and TestBench are default-off or bounded; systemd caps account optional workers and MCP scopes. |
| Shared monitor | #772 | One Kiba monitors prod/staging with environment labels and guarded remediation. |
| Host/cache budgets | #773, #779, #769 | Mail/Docker reserve is explicit; protected host services are guarded; only narrow optional services/cache paths are cleanup candidates. |
| Naruto/Sasuke guardrail | #764 | Naruto and Sasuke remain separate until a separately reviewed compatibility experiment proves safe. |
| Runtime retention and capacity | #754 | High-volume cases/effects/events have retention classes, compaction defaults, audit access, and safety gates. |

## Non-Negotiables

- Sasuke user-account ingestion remains protected by `agent-sasuke.service`,
  `agent-watchdog-sasuke.service`, Telegram user streams, and the
  `telethon-channel` / `bitrix24` owner allowlist.
- Naruto remains orchestration-critical and separate from Sasuke. Pausing or
  merging Naruto requires the ADR-007 experiment, not a diet cleanup.
- Mail stack is reserved in the host budget. Lean cleanup must not
  disable Docker/mail services or delete mail data.
- Heavy MCP packs, direct browser MCP, TestBench, and optional SDD/QA workers
  remain bounded or on-demand.

## Measured Evidence

The savings below are source-level evidence and live samples from accepted child
issues. Some rows can overlap when stale broad agent configs contain multiple
optional packs; the JSON report marks additivity explicitly.

| Evidence | Process delta | RSS delta |
| --- | ---: | ---: |
| Konoha MCP orphan cleanup | 30 fewer | 2,400,000 KiB |
| Kiba broad MCP -> monitor core target | 28 fewer | 1,346,324 KiB |
| Office/Miro/browser default-off | 9 fewer | 378,000 KiB |
| Duplicate Telethon/Bitrix owner gate | 2 fewer | 142,788 KiB |
| TestBench browser pool default-off outside QA | 8 fewer | 505,232 KiB |
| Optional host-service disable candidates | operator-reviewed | about 128,000 KiB |

The expected baseline is not "everything stopped"; it is `prod-core`: Konoha
API, Redis/PostgreSQL, Telegram ingestion, Naruto/Sasuke, Akamaru, and bounded
Kiba monitoring. `prod-full` may enable the SDD watchdog lane, but developer and
QA runtimes still stay on demand.

## Review Commands

```bash
KONOHA_SERVICE_PROFILE=prod-core python3 scripts/healthcheck-system.py --policy-dry-run
KONOHA_SERVICE_PROFILE=prod-core python3 scripts/healthcheck-system.py
python3 scripts/resource-inventory.py --json --no-disk
PATH=/home/ubuntu/.bun/bin:$PATH bun run scripts/pg-read-readiness-report.ts --json
PATH=/home/ubuntu/.bun/bin:$PATH bun run scripts/pg-only-retention-report.ts --json
```

Focused contract check:

```bash
PATH=/home/ubuntu/.bun/bin:$PATH bun test --timeout 30000 \
  tests/lean-runtime-diet-report.test.ts \
  tests/tool-profiles.test.ts \
  tests/resource-budget-contract.test.ts \
  tests/runtime-retention-policy.test.ts
python3 -m pytest tests/test_service_profiles.py tests/test_healthcheck_policy.py
```

## Rollback

- Agent systemd scopes: set `KONOHA_AGENT_SYSTEMD_SCOPE=0` for the affected
  restart if transient scope accounting is the failure mode.
- MCP on-demand wrapper: set `KONOHA_MCP_SYSTEMD_SCOPE=0` for the task/session
  MCP config if systemd scope creation fails.
- SDD worker pool: run
  `python3 scripts/sdd-worker-pool.py rollback --reason <reason>`.
- Host-service audit: run candidate `rollback_commands` from
  `docs/resource-budgets.json`.
- Naruto/Sasuke: restart both runtime/watchdog units and do not reset Sasuke
  Redis consumer groups.

## Remaining Gaps

The architecture work is ready for review closure. Remaining items are
operational validation, not new architecture blockers:

- run a clean live `prod-core` inventory after stale agent workdirs/processes
  are restarted/regenerated;
- keep mail externalization as a separate future migration;
- keep Naruto pause or consolidation blocked by ADR-007 until separately
  reviewed.
