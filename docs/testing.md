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
| `KONOHA_TOKEN` | No | `konoha-dev-token` | Auth token for API calls. E2E uses dev fallback — no setup needed for local runs. |
| `KONOHA_PORT` | No | `3100` | Backend server port. E2E uses `3202` (isolated from dashboard on 3201). |

## E2E auth architecture

Auth is **client-side only** — no server sessions or cookies.

- `frontend/src/pages/Login.tsx` validates credentials and sets `localStorage['konoha_dash_auth'] = '1'`
- `frontend/src/entries/app.tsx:54` checks this flag; redirects to `/login` if absent
- `playwright/global-setup.ts` sets localStorage directly via `page.evaluate()` — no form login, no `E2E_PASSWORD` needed
- `playwright/.auth/user.json` stores the resulting `storageState` (localStorage snapshot)

API auth (`requireAuth` in `src/middleware/auth.ts`) uses **only** `Authorization: Bearer <token>` — cookies are not checked. `extraHTTPHeaders` in `playwright.config.ts` injects the token into all Playwright requests (page + request fixture).

## E2E server isolation

Port `3201` is reserved by `konoha-dashboard` — see `docs/ports.md`. E2E test server always starts on port `3202` with `reuseExistingServer: false` to avoid accidentally attaching to the wrong process (root cause of issue #435).

## Key lessons learned

- **#435**: `reuseExistingServer: true` caused Playwright to attach to konoha-dashboard (port 3201) instead of the backend. Always use `reuseExistingServer: false` for isolated test runs.
- **#438**: `E2E_PASSWORD` approach failed because login is client-side. Use `page.evaluate()` to set localStorage directly.
- **#440**: `widgetState` and `showMobSide` are React state — components are conditionally rendered. Tests must trigger UI interactions before asserting component presence.
