# Konoha Staging Environment

Issue #753 provisions a staging lane for Workflow Engine development and QA
without touching production Redis DB `0`, the production PostgreSQL `public`
schema, Telegram streams, or production agent workdirs.

The machine-readable contract is `docs/staging-environment.json`; the service
profile remains `staging-core` from `docs/service-profiles.json`.

## Environment

Create `/opt/shared/.agent-env.staging` from
`runtime-config/staging-core.env.example` and fill only staging secrets there.
Do not source `/home/ubuntu/.agent-env` into the staging service.

Required defaults:

- `KONOHA_ENV=staging`
- `KONOHA_SERVICE_PROFILE=staging-core`
- `KONOHA_PORT=3210`
- `KONOHA_URL=http://127.0.0.1:3210`
- `KONOHA_STAGING_URL=http://127.0.0.1:3210`
- `REDIS_DB=2`
- `STAGING_DATABASE_URL` and `DATABASE_URL` point at `konoha_staging` with
  `search_path=konoha_staging,public`
- `KONOHA_SETUP_FILE=/opt/shared/.konoha-setup.staging.json`
- `KONOHA_DASHBOARD_AUTH_FILE=/opt/shared/.dashboard-auth.staging.json`
- `KONOHA_AGENT_WORKDIR_ROOT=/opt/shared/agent-workdirs-staging`

Ports `3200`, `3201`, and `3202` are deliberately not used by staging: they are
reserved for production bus, dashboard, and E2E tests.

## Setup

Validate the template before copying it:

```bash
bun run scripts/staging-environment.ts check --env-file runtime-config/staging-core.env.example
```

Initialize the staging PostgreSQL schema:

```bash
set -a
source /opt/shared/.agent-env.staging
set +a
bun run scripts/staging-environment.ts init
```

Start the staging service only after the lean baseline gate is satisfied or a
time-boxed waiver is recorded in `/opt/shared/konoha-staging-waiver.json`.
The staging systemd unit/drop-in must source `/opt/shared/.agent-env.staging`
and install `systemd/dropins/staging-core-konoha.conf`; production
`konoha.service` must keep using its production environment.

## Smoke

Dry-run smoke validates configuration and the reset plan without network or
database writes:

```bash
scripts/staging-smoke.sh --dry-run
```

Live smoke checks the staging API and PostgreSQL mirror using the staging env:

```bash
set -a
source /opt/shared/.agent-env.staging
set +a
scripts/staging-smoke.sh --live
```

The live smoke uses `KONOHA_URL=$KONOHA_STAGING_URL` for `/health` and
`/agents`, then runs:

```bash
KONOHA_SERVICE_PROFILE=staging-core REDIS_DB=2 DATABASE_URL="$STAGING_DATABASE_URL" bun run scripts/pg-verify.ts
```

## Agents And Connectors

Staging agents are visibly marked with `staging-` IDs, run in
`staging.konoha`, and use `/opt/shared/agent-workdirs-staging`. The default
model is a simple on-demand team: `staging-kakashi`, `staging-shino`, and
`staging-hinata`. Production IDs such as `naruto`, `sasuke`, `kakashi`, and
`shikadai` are forbidden in staging seed data.

External connectors are disabled by default. Telegram, Bitrix, Yonote, mail,
packers, and bridge services require `KONOHA_STAGING_ENABLE_EXTERNAL_CONNECTORS`
plus an operator waiver before they can be enabled for a bounded exercise.

## Reset

Reset is dry-run by default and refuses production-looking environments:

```bash
set -a
source /opt/shared/.agent-env.staging
set +a
bun run scripts/staging-environment.ts reset --dry-run
```

Apply reset only to the staging storage:

```bash
bun run scripts/staging-environment.ts reset --apply
```

The reset command scans configured Redis patterns in DB `2` and truncates only
contracted staging PostgreSQL tables through the staging search path. It never
uses `FLUSHDB`, `FLUSHALL`, `DROP DATABASE`, production Redis DB `0`, or the
PostgreSQL `public` schema.

## Rollback

```bash
sudo systemctl stop konoha-staging.service || true
sudo systemctl unset-environment KONOHA_SERVICE_PROFILE KONOHA_ENV KONOHA_PORT KONOHA_STAGING_URL STAGING_DATABASE_URL
set -a
source /opt/shared/.agent-env.staging
set +a
bun run scripts/staging-environment.ts reset --apply
```

Rollback does not stop or restart production `konoha.service`, Telegram, Redis,
PostgreSQL, nginx, or mail services.
