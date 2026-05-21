#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export KONOHA_ENV="staging"
export KONOHA_SERVICE_PROFILE="staging-core"
export KONOHA_PORT="${KONOHA_STAGING_PORT:-3210}"
export KONOHA_STAGING_URL="${KONOHA_STAGING_URL:-http://127.0.0.1:${KONOHA_PORT}}"
export KONOHA_URL="$KONOHA_STAGING_URL"
export KONOHA_PUBLIC_URL="$KONOHA_STAGING_URL"
export REDIS_DB="${KONOHA_STAGING_REDIS_DB:-2}"
export STAGING_DATABASE_URL="${STAGING_DATABASE_URL:-postgres://127.0.0.1:5432/konoha_staging?options=-c%20search_path%3Dkonoha_staging%2Cpublic}"
export DATABASE_URL="$STAGING_DATABASE_URL"
export KONOHA_AGENT_WORKDIR_ROOT="${KONOHA_AGENT_WORKDIR_ROOT:-/opt/shared/agent-workdirs-staging}"
export KONOHA_VILLAGE_ID="${KONOHA_VILLAGE_ID:-staging.konoha}"
export KONOHA_ENABLED_CONNECTORS="${KONOHA_ENABLED_CONNECTORS:-}"
export KONOHA_HEALTH_ENABLED_CONNECTORS="${KONOHA_HEALTH_ENABLED_CONNECTORS:-}"

MODE="${1:---dry-run}"
case "$MODE" in
  --dry-run)
    bun run scripts/staging-environment.ts check
    bun run scripts/staging-environment.ts smoke --dry-run
    ;;
  --live)
    bun run scripts/staging-environment.ts check
    bun run scripts/staging-environment.ts smoke --live
    KONOHA_SERVICE_PROFILE=staging-core REDIS_DB="$REDIS_DB" DATABASE_URL="$STAGING_DATABASE_URL" bun run scripts/pg-verify.ts
    ;;
  *)
    echo "Usage: scripts/staging-smoke.sh [--dry-run|--live]" >&2
    exit 2
    ;;
esac
