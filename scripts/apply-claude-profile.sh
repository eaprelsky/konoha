#!/bin/bash

set -euo pipefail

set -a
source /home/ubuntu/.agent-env
set +a
source /home/ubuntu/konoha/scripts/claude-provider.sh

PROFILE="${1:-${KONOHA_CLAUDE_PROVIDER_PROFILE:-deepseek}}"
konoha_write_claude_settings "${HOME}/.claude/settings.json" "$PROFILE"
