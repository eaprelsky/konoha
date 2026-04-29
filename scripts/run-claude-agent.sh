#!/bin/bash

set -euo pipefail

PROFILE_OVERRIDE="${KONOHA_CLAUDE_PROVIDER_PROFILE:-}"

set -a
source /home/ubuntu/.agent-env
set +a

if [ -n "$PROFILE_OVERRIDE" ]; then
    export KONOHA_CLAUDE_PROVIDER_PROFILE="$PROFILE_OVERRIDE"
fi
source /home/ubuntu/konoha/scripts/claude-provider.sh

REQUESTED_MODEL="${1:-sonnet}"
shift || true

ACTIVE_PROFILE="${KONOHA_CLAUDE_PROVIDER_PROFILE:-deepseek}"
ACTUAL_MODEL="$(konoha_claude_resolve_model "$REQUESTED_MODEL" "$ACTIVE_PROFILE")"
konoha_export_claude_provider_env "$ACTIVE_PROFILE"
export ANTHROPIC_MODEL="$ACTUAL_MODEL"

exec claude --model "$ACTUAL_MODEL" "$@"
