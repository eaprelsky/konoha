#!/bin/bash
# Safe restart protocol for Claude agents.
# Usage: safe-restart.sh <agent_id> [delay_sec]
#
# Flow:
# 1. Write watchdog file so the other agent can verify recovery
# 2. Post RESTART_INITIATED event to Konoha
# 3. Call the agent's restart script

AGENT="${1:-naruto}"
DELAY="${2:-5}"
KONOHA_URL="${KONOHA_URL:-http://127.0.0.1:3200}"
source /home/ubuntu/.agent-env 2>/dev/null

echo "[safe-restart] Initiating safe restart for $AGENT..."

# Write watchdog file with current timestamp
WATCHDOG_FILE="/tmp/watchdog-${AGENT}.txt"
echo "$(date +%s)" > "$WATCHDOG_FILE"
echo "[safe-restart] Watchdog file written: $WATCHDOG_FILE"

# Notify Konoha
curl -s -X POST \
  -H "Authorization: Bearer $KONOHA_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"from\":\"${KONOHA_AGENT_ID:-sasuke}\",\"to\":\"all\",\"type\":\"status\",\"text\":\"RESTART_INITIATED:$AGENT\"}" \
  "$KONOHA_URL/messages" > /dev/null 2>&1

echo "[safe-restart] Konoha notified. Running restart in ${DELAY}s..."

# Call the appropriate restart script
RESTART_SCRIPT="/home/ubuntu/scripts/restart-${AGENT}.sh"
if [[ -f "$RESTART_SCRIPT" ]]; then
  bash "$RESTART_SCRIPT" "$DELAY"
else
  echo "[safe-restart] ERROR: $RESTART_SCRIPT not found"
  rm -f "$WATCHDOG_FILE"
  exit 1
fi
