# P0 Auth Hardening Report

Date: 2026-04-29
Status: implemented
Related plan: `docs/security/2026-04-29-people-auth-audit-plan.md`

## Scope

This hardening pass implements the first P0 security controls from the people/auth audit plan:

- brute-force protection for dashboard authentication endpoints
- production preflight checks for dashboard auth invariants and secret hygiene
- regression tests for rate limiting and dashboard-host auth boundary

This pass does not migrate People to the canonical DB store yet.

## Changes

### Dashboard Auth Rate Limiting

`/auth/login` now rate-limits repeated failed attempts by client IP and username.

`/auth/password` now rate-limits repeated password-change attempts by client IP and authenticated dashboard subject.

Both rate-limited paths emit audit events with `result: "blocked"` and reason `rate_limited`.

### Security Healthcheck

`scripts/healthcheck-system.py` now reports these checks:

- `security.temp_secrets`: fails if known one-time secret files or `.agent-env.bak.*` files are present.
- `security.dashboard_auth_file`: verifies the dashboard password hash file is not group/world-readable.
- `security.nginx_dashboard_auth`: fails if dashboard nginx server blocks inject `Authorization: Bearer`.
- `security.nginx_secret_backups`: fails if nginx active config/backups contain bearer injection snippets.

### Regression Coverage

`tests/server.test.ts` now covers:

- repeated dashboard login failures return `429` after the allowed threshold
- repeated password-change failures return `429` after the allowed threshold
- dashboard-host requests cannot authenticate with bearer alone

## Verification

Commands run:

```bash
bun test tests/server.test.ts --preload ./tests/setup.ts
bun x tsc --noEmit
python3 scripts/healthcheck-system.py | grep -E "security\\.|summary"
```

Observed results:

- `41 pass`, `0 fail` for `tests/server.test.ts`
- TypeScript check passed
- security healthcheck lines all OK
- healthcheck summary: `55 OK, 0 WARN, 0 FAIL`

## Residual Risks

- This is endpoint-level brute-force mitigation, not a full abuse-protection stack. There is still no global IP reputation, CAPTCHA, WAF, or distributed rate-limit strategy.
- The route authorization inventory is not complete yet. The next backlog item should enumerate all routes and classify allowed caller types.
- People still uses mixed file/Redis sources. The People DB migration remains open.

## Next Recommended Step

Implement route authorization inventory as a code-backed check:

- declare expected auth class for each route group
- add tests for representative mutating routes
- fail preflight on dangerous drift for dashboard/admin-only routes

