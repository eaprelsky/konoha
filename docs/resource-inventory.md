# Live Resource Inventory

Issue #760 adds a repeatable live resource report for Konoha runtime budgeting.
Use it instead of ad hoc `ps` snapshots when deciding whether a service, agent,
or MCP pack is inside its budget.

Fallback service budgets and cache/artifact disk budgets come from
`docs/resource-budgets.json`. Profile-level envelopes and scale-out policy are
documented in `docs/resource-budget-policy.md`.

## Command

```bash
python3 scripts/resource-inventory.py
python3 scripts/resource-inventory.py --json
python3 scripts/resource-inventory.py --json --no-disk
```

The text report is for operators. JSON is for healthcheck/admin diagnostics and
post-incident capture.

## Coverage

The report groups current RSS and CPU by:

- `core_konoha_api`
- `managed_agent`
- `mcp_server`
- `telegram_connector`
- `testbench_browser`
- `docker_mail_stack`
- cache/artifact disk entries such as npm, uv, Bun, Playwright, and
  `node_modules`

Process rows include inferred `agent_id`, `mcp_server`, `systemd_unit`, and
`systemd_slice` where available. Agent and MCP origins are inferred from
`/opt/shared/agent-workdirs/<id>`, `.mcp.json` paths, process ancestry, and
known MCP command names.

## Budgets

`scripts/resource-inventory.py` reads systemd `MemoryCurrent`, `MemoryPeak`,
`MemoryMax`, `CPUUsageNSec`, CPU quota, `Result`, `NRestarts`, and `OOMKilled`
fields for Konoha slices and known services. Group summaries include:

- current `rss_kib`
- current `cpu_percent`
- `peak_rss_kib` where systemd exposes `MemoryPeak`
- `budget_max_kib`
- `budget_pressure`: `ok`, `warning`, `critical`, or `unknown`

JSON output also includes `service_budgets[]`, one row per known Konoha service
or slice, with current/peak/max memory, `memory_limit_hit`, restart/OOM state,
and pressure. When deployed systemd units still report `MemoryMax=infinity`, the
report falls back to the committed Konoha budget contract so pressure remains
visible during migration.

`scripts/healthcheck-system.py` runs the inventory with `--json --no-disk` and
emits `resource_inventory.budget_pressure`, `resource_inventory.limit_hits`, or
`resource_inventory.oom_restarts`, so healthcheck/admin diagnostics can show
pressure and OOM restarts without a slower disk scan.

## Redaction

Command arguments are redacted before output. Bearer tokens, `*_TOKEN`,
`*_SECRET`, `*_PASSWORD`, `*_API_KEY`, webhook values, sensitive query
parameters, and long hex secrets are replaced with redaction markers.

Do not paste raw `ps` output into issues when this report is available.
