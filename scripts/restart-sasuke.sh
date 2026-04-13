#!/bin/bash
# Restart Sasuke via Konoha managed lifecycle API.
# Usage: restart-sasuke.sh [delay_seconds]

set -euo pipefail

DELAY="${1:-5}"
echo "[$(date)] Restart requested. Waiting ${DELAY}s before restart..."
sleep "$DELAY"
source /home/ubuntu/.agent-env
echo "[$(date)] Restarting managed agent sasuke via Konoha API..."
curl -sf -X POST -H "Authorization: Bearer $KONOHA_TOKEN" "http://127.0.0.1:3200/agents/sasuke/restart" >/dev/null
echo "[$(date)] Restart complete."
