# Konoha Port Registry

> Keep this file up to date when adding new services.
> Background: port conflict between konoha-dashboard (3201) and Playwright E2E caused 5 fix iterations — see issue #435.

| Port | Service | Env var | Notes |
|------|---------|---------|-------|
| 3100 | Konoha backend (API server) | `KONOHA_PORT` | Default; routes: /workflows, /agents, /messages |
| 3200 | Konoha bus (HTTP + MCP) | `KONOHA_PUBLIC_URL` | Inter-agent message bus, SSE stream |
| 3201 | konoha-dashboard | n/a | Monitoring UI — DO NOT use for E2E tests |
| 3202 | E2E test backend | `KONOHA_PORT=3202` | Playwright webServer; isolated instance, reuseExistingServer: false |
| 3203 | konoha-testbench | `TESTBENCH_PORT` | On-demand bounded Chromium testbench API |
| 3210 | Konoha staging API/bus | `KONOHA_PORT=3210`, `KONOHA_STAGING_URL` | Isolated `staging-core` lane for #753; Redis DB 2 and `konoha_staging` PostgreSQL |

## Rules

- Never start a new service on a port already in this table without updating it first.
- Playwright E2E must always use a port **not** occupied by any persistent service.
- When adding a service, add a row here in the same commit.
