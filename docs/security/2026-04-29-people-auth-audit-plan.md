# People/Auth Security Audit and Refactor Plan

Date: 2026-04-29
Status: proposed backlog
Scope: dashboard auth, people directory, trusted users, Telegram dispatch, profile UX, secret hygiene

## Executive Summary

`/opt/shared/.trusted-users.json` currently has two responsibilities:

- access control / trusted Telegram users
- people directory source of truth

This coupling was useful as a bootstrap shortcut, but it is not a production-grade model. It caused direct product friction after the runtime defacement fix: file-based users cannot be edited safely through `people:custom`, while the UI still treated them as editable profiles.

Target direction: move People to a normal persistent store and keep trust/ACL as a separate security concern.

## Current Risks

### P0/P1 Security

- Dashboard auth was recently moved server-side, but it needs a follow-up audit for session lifecycle, rate limiting, and cookie settings.
- Dashboard API must never rely on nginx-injected admin bearer tokens. Current nginx dashboard config uses `X-Konoha-Dashboard: 1`; this invariant should be covered by an automated deployment check.
- User-visible config writes (`branding`, `people`) are now admin-only and audited, but the wider API still has mixed `requireAuth`/`requireAdmin` boundaries that need review.
- Secrets existed in temporary files during the incident response. The initial dashboard password file and nginx bearer backup have been removed.

### People/Profile Model

- `trusted-users.json` is treated as immutable profile data, access-control list, and employee directory at the same time.
- Redis `people:custom` is mutable runtime state and should not be a long-term source of truth for employees.
- `findPersonByRole` and `findPersonById` search custom Redis records before trusted users, which is a dangerous precedence model unless collisions are blocked everywhere.
- `src/runtime/reminders.ts` reads `/opt/shared/.trusted-users.json` directly, bypassing the people-directory abstraction.
- `src/routes/whitelist.ts` mutates the trusted-users file directly; this should become an ACL/whitelist module, not a people-profile editor.

### Product/UX

- Profile editing mixes unrelated concerns: employee profile, avatar, skills, dashboard password.
- File-based profiles create confusing UI states: some fields look editable but cannot be saved.
- There is no explicit admin user/account model distinct from people records.

## Target Architecture

### Entities

- `people`: canonical directory records for humans.
- `people_identities`: external identities such as Telegram, email, Tracker, Bitrix24, Yonote.
- `people_roles` or `person_capabilities`: skills and role metadata used by workflow assignment.
- `access_grants`: ACL entries for dashboard, Telegram bot, userbot, admin operations.
- `dashboard_users`: dashboard login/session credential records, separate from people directory.
- `people_import_runs`: import/sync history from Yonote or other sources.

### Source Responsibilities

- Yonote/staff directory: source for employee roster import.
- People DB: operational source of truth for workflow dispatch and UI.
- Access grants: source of truth for who may use the system.
- `trusted-users.json`: deprecated bootstrap/import fallback only, then removed from runtime paths.

## Backlog

### 1. Security Boundary Audit

Goal: verify every mutating endpoint has the correct caller class.

Tasks:

- Inventory all routes and classify them as public, dashboard-session, agent-token, admin-token, webhook, or internal-only.
- Add route metadata/tests for auth class expectations.
- Promote dangerous mutating routes from `requireAuth` to `requireAdmin` or scoped action permissions.
- Add a preflight check that dashboard nginx configs do not inject `Authorization: Bearer`.
- Add rate limiting for `/auth/login` and `/auth/password`.

Acceptance criteria:

- A test fails if dashboard-host requests can authenticate with bearer alone.
- A test fails if known admin-only routes accept regular agent tokens.
- `scripts/preflight.sh` reports nginx dashboard auth-injection regressions.

### 2. People Store Phase 1: Canonical Repository

Goal: introduce a single people repository without changing product behavior.

Tasks:

- Add `konoha_people`, `konoha_people_identities`, and `konoha_people_avatars` schema.
- Implement `src/people-store.ts` with list/upsert/delete/find-by-id/find-by-role.
- Preserve read compatibility by importing both `trusted-users.json` and `people:custom` into the repository.
- Keep Redis/file fallback read-only during the first phase.

Acceptance criteria:

- `/people` reads from the repository.
- Dispatcher and reminders use the repository, not direct file reads.
- Existing staff and custom records remain visible after migration.

### 3. People Store Phase 2: Import and Sync

Goal: replace file sync with idempotent imports.

Tasks:

- Convert `scripts/sync-trusted-users-from-yonote.py` into a Yonote-to-people importer.
- Store source metadata: `source`, `source_id`, `synced_at`, `import_run_id`.
- Add dry-run/diff mode before applying changes.
- Add duplicate detection by Telegram ID, username, email, and normalized name.

Acceptance criteria:

- Import is idempotent.
- Import cannot silently overwrite manual fields without conflict policy.
- Import report is saved and auditable.

### 4. ACL/Whitelist Separation

Goal: remove people-profile semantics from trusted-users.

Tasks:

- Introduce `access_grants` store for Telegram/dashboard/system access.
- Refactor `src/routes/whitelist.ts` to manage access grants, not `.trusted-users.json`.
- Update preflight validation to require access grants, not trusted-user file records.
- Add emergency bootstrap path for first admin only.

Acceptance criteria:

- Whitelist operations do not mutate people profiles.
- Removing a person from people does not implicitly remove admin credentials without explicit ACL action.
- Grant/revoke operations are audited.

### 5. Profile UX Refactor

Goal: make profile editing predictable and aligned with backend ownership.

Tasks:

- Split Profile modal into tabs: Profile, Avatar, Security.
- Show source and edit policy explicitly.
- Allow editable fields only for records whose source policy allows UI writes.
- Keep password change independent from people save.

Acceptance criteria:

- Password change never calls `/people`.
- File/imported profiles do not show misleading editable fields.
- Admin can see where to edit source-owned fields.

### 6. Secret Hygiene and Incident Controls

Goal: prevent repeat of temporary secret exposure.

Tasks:

- Add preflight checks for known secret-bearing backup files and nginx bearer injection.
- Add `scripts/security-scan.sh` for repo, dist, nginx snippets, and shared temp files.
- Add a secret rotation runbook for `KONOHA_TOKEN`, dashboard password, agent tokens, OpenRouter keys, GitHub token.
- Add audit events for login failures, password changes, grants, profile imports, and sensitive config writes.

Acceptance criteria:

- Preflight fails on known generated password files and nginx bearer backups.
- Security scan can run safely without printing secret values.
- Rotation runbook is documented and tested on staging/maintenance window.

## Proposed Execution Order

1. Close P0 hardening gaps: route inventory, nginx/preflight checks, auth rate limiting.
2. Build people repository and migrate reads behind a feature flag.
3. Import existing file/Redis people into DB and validate parity.
4. Move dispatcher/reminders/roles to people repository.
5. Split whitelist/access grants from people records.
6. Retire runtime reads from `.trusted-users.json`.
7. Clean UX and docs after runtime paths are gone.

## Open Decisions

- Whether people store should be Postgres-only immediately or Redis-shadowed during migration.
- Whether dashboard users should link to people records or stay independent with optional `person_id`.
- Whether Yonote remains the roster source of truth or becomes one import source among several.
- Which fields are source-owned versus UI-editable after import.

## Coverage Limits

This plan is based on a source-level review of current people/auth call sites. It is not yet a full line-by-line audit of every route or all infrastructure configs. The next step should produce route-level auth inventory and concrete GitHub issues.
