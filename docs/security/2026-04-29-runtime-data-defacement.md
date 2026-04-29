# 2026-04-29 Runtime Data Defacement

## Summary

The web UI showed defaced values in the site title and people directory. The malicious strings were not present in tracked source code or git history; they were stored in runtime Redis data.

Affected Redis keys:

- `konoha:config:branding`
- `people:custom`

Runtime data was restored immediately, and write access to the affected API surfaces was tightened.

## Evidence

Observed live API responses before remediation:

- `GET /api/branding` returned `product_name: "писюны228"`.
- `GET /api/people` returned a custom override for `@yegor_aprelsky` with abusive name, position, username, and email fields.

Repository checks:

- Source search for the malicious strings found no tracked code occurrence.
- Git history search for the malicious strings found no matching commit.

Redis checks:

- `GET konoha:config:branding` contained the defaced branding JSON.
- `HGETALL people:custom` contained the defaced `@yegor_aprelsky` custom person record.

## Root Cause

The affected writes were authenticated but not admin-only:

- `PUT /branding` accepted any valid authenticated caller.
- `POST /people`, `DELETE /people/:id`, and `POST /people/:id/avatar` were writable by regular agent tokens through the server-level auth boundary.

This allowed a non-admin agent token to modify user-visible configuration and custom people records. The incident did not require a source-code commit.

## Remediation

Runtime data was restored:

- `konoha:config:branding` reset to the normal Konoha WE defaults.
- The malicious `people:custom` entry for `@yegor_aprelsky` was deleted, restoring the trusted file-based person record.

Code hardening:

- `PUT /branding` now requires the admin token.
- People mutation routes now require the admin token.
- `POST /people` rejects custom records that try to override file-based trusted users by id.

Regression coverage:

- Added tests proving regular agent tokens cannot update branding.
- Added tests proving regular agent tokens cannot create custom people.
- Added tests for admin branding updates and custom people create/delete.
- Added a guard test for trusted-user override protection when trusted users are present.

## Residual Risk

Attribution is limited because these routes did not previously emit a dedicated audit event, and Redis does not preserve key modification timestamps. If stronger forensic attribution is needed, add structured audit logging for all user-visible configuration writes and include caller identity, route, target id, and request id.

