#!/bin/bash
# Restart Mirai via Konoha managed lifecycle API.
# Usage: restart-mirai.sh [delay_seconds]

set -euo pipefail

DELAY="${1:-5}"
echo "[$(date)] Restart requested. Waiting ${DELAY}s before restart..."
sleep "$DELAY"
source /home/ubuntu/.agent-env
echo "[$(date)] Restarting managed agent mirai via Konoha API..."
curl -sf -X POST -H "Authorization: Bearer $KONOHA_TOKEN" "http://127.0.0.1:3200/agents/mirai/restart" >/dev/null
echo "[$(date)] Restart complete."
