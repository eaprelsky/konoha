# Cache Retention And Cleanup Policy

Issue #769 defines bounded disk cache retention for the Lean Konoha runtime.
The machine-readable source of truth is `disk_budgets` in
`docs/resource-budgets.json`.

## Inventory

Use the resource inventory before and after cleanup:

```bash
python3 scripts/resource-inventory.py
python3 scripts/resource-inventory.py --json | jq '.disk'
python3 scripts/healthcheck-system.py | rg 'resource_inventory'
```

The inventory covers npm/npx, uv, Bun, Playwright, Puppeteer, local tooling,
repository `node_modules`, template `node_modules`, journald, and agent runtime
logs. Healthcheck includes the disk section and warns when any cache reaches
warning or critical budget pressure.

## Automated Safe Path

`npm_npx_cache` is the default automated cleanup target. It deletes only stale
child directories under `/home/ubuntu/.npm/_npx`, never the cache root, and
skips any child path referenced by active process args.

Dry-run:

```bash
python3 scripts/cache-retention-cleanup.py --target npm_npx_cache
python3 scripts/cache-retention-cleanup.py --target npm_npx_cache --json
```

Apply:

```bash
python3 scripts/cache-retention-cleanup.py --target npm_npx_cache --apply
```

Run `python3 scripts/resource-inventory.py --json | jq '.disk'` after apply and
confirm `npm_npx_cache` and parent `npm_cache` pressure moved down or that all
remaining npx directories are active/recent.

## Manual Cleanup Commands

| Cache | Dry-run / inspect | Apply policy |
| --- | --- | --- |
| npm/npx | `npm cache verify`; `python3 scripts/cache-retention-cleanup.py --target npm_npx_cache` | First remove stale npx children with the script. Use `npm cache clean --force` only in a maintenance window with no active npm/npx install. |
| uv | `uv cache dir`; inspect active `uv`/`uvx` processes | `uv cache prune` only after confirming no active MCP/service depends on the cache path. |
| Playwright | `ps -eo args= | rg ms-playwright`; inspect `/home/ubuntu/.cache/ms-playwright` | Never delete while TestBench/Chromium is active. Remove old revisions only after stopping TestBench and confirming browser smoke can reinstall/run. |
| Puppeteer | `ps -eo args= | rg puppeteer` | Prefer disabling `direct-browser-mcp`; delete only unused revisions with no active Puppeteer/Chrome process. |
| Bun | inspect `/home/ubuntu/.bun/install/cache` | `bun pm cache rm` only during maintenance; reinstall dependencies if needed. |
| logs | `journalctl --disk-usage`; `du -sh /opt/shared/kiba/logs` | Use `scripts/konoha-agent-log-retention.sh` and the journald 1 GiB / 14 day policy. |
| build artifacts | inspect repository and template workdirs | Remove generated artifacts only inside the owning build/test workflow; do not remove active service dependencies. |

## Guardrails

- Do not delete active venvs, active browser revisions, running MCP tool caches,
  service binaries, or repository dependencies used by currently running
  systemd services.
- Browser caches are inventory-only unless TestBench/browser processes are
  stopped and a reinstall/smoke path is available.
- `.local` is inventory-only because it contains active uv binaries and local
  Python tools used by MCP and mail/service integrations.
- Docker/mail data is outside this cache cleanup policy; mail cleanup remains a
  separate migration/backup decision.
