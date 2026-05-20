# Testing Guide

## Running tests

### Portable preflight (CI-safe)
```bash
scripts/preflight-portable.sh
```

This is the GitHub Actions gate. It runs backend typecheck, the portable backend regression suite, frontend typecheck, frontend unit tests, and frontend build. It requires Redis and PostgreSQL, but does not require production systemd units, Telegram credentials, live agent tmux sessions, or production secrets.
It also validates the BPMS load regression profile catalog and the portable
`ci-bpms-regression` report fixture. It validates the data-store disaster
recovery contract and uses a portable staging restore drill fixture.

### Production preflight (server gate)
```bash
scripts/preflight.sh
```

This is the release gate on `agent.eaprelsky.ru`. It includes the portable checks plus production-only system health, lifecycle/watchdog validation, Telegram smoke, and PostgreSQL shadow verification. Run this before large Workflow Engine changes or after changing lifecycle/runtime/watchdog/storage code.
For broad BPMS changes, set `BPMS_LOAD_PROFILE=release-gate-staging` or
`BPMS_LOAD_PROFILE=staging-soak-8h`, set `BPMS_LOAD_OBSERVATIONS` to the staging
observation file, and keep `BPMS_LOAD_REPORT` at the default
`/tmp/bpms-load-regression-report.json` unless the release record needs another
path.
Data-store disaster recovery is checked by `scripts/data-store-drill.ts`. For a
real staging restore drill, set `DATA_STORE_DRILL_OBSERVATIONS` and attach the
generated `konoha-data-store-drill-report.json` to the release gate.
Mail integration reliability is checked by
`scripts/mail-integration-profile.ts`; it keeps the shared mail host, tenant
separation, DNS/auth posture, retry/dead-letter behavior, and optional MCP
boundary under contract.

As of 2026-04-30, PostgreSQL shadow verification can fail with bloat-only exit code `2` while still reporting `onlyInRedis=0`. That means Redis -> PG sync is complete, but PG-only historical retention is not yet governed. Treat `onlyInRedis` as a release blocker; treat bloat-only failures as data-retention debt until the retention report/cleanup policy is implemented.

Before broad BPMS refactors or staging rollout work, also satisfy
`docs/lean-baseline-gate.md`: `prod-core` must be live-clean, or Naruto must
record a time-boxed waiver. The #753 staging plan must use `staging-core`, not
the current full production profile.

Workflow construction/runtime security changes must also satisfy
`docs/workflow-security-boundary.md`. The release gate runs
`action_security_boundary`, which checks the generated Action Spine surface and
high-risk route authorization policy.

### Unit tests
```bash
bun test
```

`bun test` uses the root `bunfig.toml` preload (`tests/setup.ts`) to isolate
storage by default:

- Redis uses `REDIS_DB=1` (or `KONOHA_TEST_REDIS_DB`) and the preload flushes
  only that DB before the run.
- PostgreSQL uses a disposable schema named `konoha_test_<pid>` (or
  `KONOHA_TEST_PG_SCHEMA`) by adding `search_path=<schema>,public` to the test
  connection URL. The preload drops/recreates that schema and loads
  `src/storage/schema.sql`.
- Runtime storage code fails fast when `KONOHA_TEST_STORAGE=1` would use Redis
  DB `0` or a PostgreSQL schema that does not start with `konoha_test`.
- Bun tests that need Redis directly must use `tests/redis-test-utils.ts`
  (`createTestRedis` / `getTestRedisDb`) instead of constructing `ioredis`
  clients inline. `tests/redis-test-isolation-contract.test.ts` audits this so
  new direct clients cannot silently fall back to DB `0`.

Do not point normal unit/integration tests at production Redis DB `0` or the
production PostgreSQL `public` schema. For a deliberate destructive integration
run, set `KONOHA_ALLOW_DESTRUCTIVE_INTEGRATION_TESTS=1` and document the target
environment in the review notes. Roll back to the safe default by unsetting
`KONOHA_ALLOW_DESTRUCTIVE_INTEGRATION_TESTS` and `KONOHA_TEST_REDIS_DB`; if a
non-production Redis DB was used for a destructive run, clean it explicitly with
`redis-cli -n <db> FLUSHDB`. Production/runtime scripts that intentionally use
Redis DB `0` are outside the Bun test isolation contract.

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
