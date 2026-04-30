# Testing Guide

## Running tests

### Portable preflight (CI-safe)
```bash
scripts/preflight-portable.sh
```

This is the GitHub Actions gate. It runs backend typecheck, the portable backend regression suite, frontend typecheck, frontend unit tests, and frontend build. It requires Redis and PostgreSQL, but does not require production systemd units, Telegram credentials, live agent tmux sessions, or production secrets.

### Production preflight (server gate)
```bash
scripts/preflight.sh
```

This is the release gate on `agent.eaprelsky.ru`. It includes the portable checks plus production-only system health, lifecycle/watchdog validation, Telegram smoke, and PostgreSQL shadow verification. Run this before large Workflow Engine changes or after changing lifecycle/runtime/watchdog/storage code.

As of 2026-04-30, PostgreSQL shadow verification can fail with bloat-only exit code `2` while still reporting `onlyInRedis=0`. That means Redis -> PG sync is complete, but PG-only historical retention is not yet governed. Treat `onlyInRedis` as a release blocker; treat bloat-only failures as data-retention debt until the retention report/cleanup policy is implemented.

### Unit tests
```bash
bun test
```

### E2E tests (Playwright)
```bash
# Requires KONOHA_TOKEN env var (or uses 'konoha-dev-token' fallback)
npx playwright test
```

## Required environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `KONOHA_TOKEN` | No | `konoha-dev-token` | Auth token for non-dashboard API calls. Production must set a strong value. |
| `KONOHA_PORT` | No | `3100` | Backend server port. E2E uses `3202` (isolated from dashboard on 3201). |
| `KONOHA_DASHBOARD_USER` | No | `admin` | Dashboard login username. Tests override it with `test-admin`. |
| `KONOHA_DASHBOARD_PASSWORD` | No | — | Bootstrap password used only to create the local password hash file. |
| `KONOHA_DASHBOARD_HOSTS` | No | — | Comma-separated dashboard hostnames where bearer tokens are not accepted without a dashboard session cookie. Tests use `dashboard.test`. |

## E2E auth architecture

Dashboard auth is server-side:

- `frontend/src/pages/Login.tsx` posts credentials to `/api/auth/login`
- the backend sets an httpOnly `konoha_dash_session` cookie
- `frontend/src/entries/app.tsx` verifies the cookie through `/api/auth/me`
- dashboard-host requests reject bearer-token auth unless a valid dashboard session cookie is present

Non-dashboard API auth (`requireAuth` in `src/middleware/auth.ts`) still accepts `Authorization: Bearer <token>` for agents, MCP clients, and internal services.

## E2E server isolation

Port `3201` is reserved by `konoha-dashboard` — see `docs/ports.md`. E2E test server always starts on port `3202` with `reuseExistingServer: false` to avoid accidentally attaching to the wrong process (root cause of issue #435).

## Key lessons learned

- **#435**: `reuseExistingServer: true` caused Playwright to attach to konoha-dashboard (port 3201) instead of the backend. Always use `reuseExistingServer: false` for isolated test runs.
- **Dashboard auth hardening**: do not put real usernames, passwords, or dashboard hostnames in tests. Use `KONOHA_DASHBOARD_*` env vars and neutral test values.
- **#440**: `widgetState` and `showMobSide` are React state — components are conditionally rendered. Tests must trigger UI interactions before asserting component presence.
